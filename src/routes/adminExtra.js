'use strict';
/** Admin: agents, agent pricing and reports. Mounted next to routes/admin.js under /api/admin. */
const express = require('express');
const { User, Txn } = require('../models');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { isDuplicateKey } = require('../utils/references');
const { randomDigits } = require('../utils/crypto');
const { fromMinor } = require('../utils/money');
const { startOfDayUtc, addDays } = require('../utils/time');
const { formatLocal } = require('../utils/phone');
const { getFees, setFees } = require('../services/agentFees');
const { present } = require('../services/presenter');
const notify = require('../services/notify');
const log = require('../utils/log');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'support'));
const adminOnly = requireRole('admin');

const name = (u) => `${u.firstName} ${u.lastName}`.trim();

/* ------------------------------------------------------------------ agents */

router.get(
  '/agents',
  asyncHandler(async (req, res) => {
    const agents = await User.find({ isAgent: true }).select('firstName lastName businessName phone agentCode balanceMinor tier status').sort({ createdAt: -1 }).limit(200).lean();
    const since = startOfDayUtc();
    const ids = agents.map((a) => a._id);
    const today = await Txn.aggregate([
      { $match: { user: { $in: ids }, kind: 'agent', status: 'Successful', createdAt: { $gte: since } } },
      { $group: { _id: { u: '$user', s: '$subtype' }, count: { $sum: 1 }, volume: { $sum: '$amountMinor' } } },
    ]);
    const map = {};
    for (const r of today) {
      const m = (map[String(r._id.u)] = map[String(r._id.u)] || { cashIn: 0, cashOut: 0, count: 0 });
      if (r._id.s === 'agent_cashin_out') m.cashIn += r.volume;
      if (r._id.s === 'agent_cashout_in') m.cashOut += r.volume;
      m.count += r.count;
    }
    const f = await getFees();
    res.json({
      fees: { cashOutPercent: f.cashOutBps / 100, minFee: fromMinor(f.minFeeMinor), agentSharePercent: f.agentSharePct },
      items: agents.map((a) => ({
        id: String(a._id),
        name: a.businessName || name(a),
        phone: formatLocal(a.phone),
        code: a.agentCode,
        float: fromMinor(a.balanceMinor),
        tier: a.tier,
        status: a.status,
        todayCashIn: fromMinor((map[String(a._id)] || {}).cashIn || 0),
        todayCashOut: fromMinor((map[String(a._id)] || {}).cashOut || 0),
        todayCount: (map[String(a._id)] || {}).count || 0,
      })),
    });
  }),
);

router.post(
  '/users/:id/agent',
  adminOnly,
  validate(S.agentSwitch),
  asyncHandler(async (req, res) => {
    const u = await User.findById(req.params.id).select('firstName lastName isAgent agentCode status onboardingStep');
    if (!u) throw E.notFound('We could not find that customer.');
    if (req.body.enabled) {
      if (u.status !== 'active' || u.onboardingStep !== 'done') throw E.conflict('Approve this account before making it an agent.', 'NOT_ACTIVE');
      if (!u.agentCode) {
        for (let i = 0; i < 12 && !u.agentCode; i++) {
          const code = `${1 + (Number(randomDigits(1)) % 9)}${randomDigits(5)}`;
          try {
            await User.updateOne({ _id: u._id, agentCode: { $exists: false } }, { $set: { agentCode: code, isAgent: true } });
            const fresh = await User.findById(u._id).select('agentCode');
            if (fresh.agentCode === code) u.agentCode = code;
          } catch (err) {
            if (!isDuplicateKey(err)) throw err;
          }
        }
        if (!u.agentCode) throw E.unavailable('Could not create an agent code. Try again.');
      }
      await User.updateOne({ _id: u._id }, { $set: { isAgent: true } });
      notify.notifyUser(u._id, { type: 'update', title: 'You are now a TrustPay agent', body: `Your agent code is ${u.agentCode}. Open Profile → Agent to start cash in and cash out.` });
    } else {
      await User.updateOne({ _id: u._id }, { $set: { isAgent: false } });
    }
    log.info('audit:agent', { by: String(req.user._id), user: String(u._id), enabled: req.body.enabled });
    res.json({ ok: true, isAgent: req.body.enabled, code: u.agentCode || null });
  }),
);

router.patch(
  '/agent-fees',
  adminOnly,
  validate(S.agentFees),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const next = {};
    if (b.cashOutPercent != null) next.cashOutBps = Math.round(b.cashOutPercent * 100);
    if (b.minFee != null) next.minFeeMinor = Math.round(b.minFee * 100);
    if (b.agentSharePercent != null) next.agentSharePct = b.agentSharePercent;
    const f = await setFees(next);
    res.json({ cashOutPercent: f.cashOutBps / 100, minFee: fromMinor(f.minFeeMinor), agentSharePercent: f.agentSharePct });
  }),
);

/* ----------------------------------------------------------------- reports */

const range = (q) => {
  const to = q.to ? new Date(q.to) : new Date();
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1)); // exclusive
  const from = q.from ? startOfDayUtc(new Date(q.from)) : addDays(end, -30);
  if (from >= end) throw E.validation('The start date must be before the end date.');
  if (end - from > 366 * 86400000) throw E.validation('Choose a period of one year or less.');
  return { from, end };
};

const DEBIT_OK = { direction: 'debit', status: 'Successful' };

router.get(
  '/reports/summary',
  validate(S.reportQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { from, end } = range(req.query);
    const inRange = { createdAt: { $gte: from, $lt: end } };
    const [daily, byKind, status, newUsers, activeUsers, tiers, top, balances] = await Promise.all([
      Txn.aggregate([
        { $match: { ...inRange, status: 'Successful' } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
            moneyOut: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$totalMinor', 0] } },
            funding: { $sum: { $cond: [{ $eq: ['$kind', 'funding'] }, '$totalMinor', 0] } },
            fees: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$feeMinor', 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Txn.aggregate([
        { $match: { ...inRange, ...DEBIT_OK } },
        { $group: { _id: '$kind', count: { $sum: 1 }, volume: { $sum: '$amountMinor' }, fees: { $sum: '$feeMinor' } } },
        { $sort: { volume: -1 } },
      ]),
      Txn.aggregate([{ $match: inRange }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      User.countDocuments({ createdAt: { $gte: from, $lt: end } }),
      Txn.distinct('user', { ...inRange, status: 'Successful' }),
      User.aggregate([{ $match: { role: 'user' } }, { $group: { _id: '$tier', users: { $sum: 1 }, balance: { $sum: '$balanceMinor' } } }, { $sort: { _id: 1 } }]),
      Txn.aggregate([
        { $match: { ...inRange, ...DEBIT_OK } },
        { $group: { _id: '$user', volume: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
        { $sort: { volume: -1 } },
        { $limit: 10 },
      ]),
      User.aggregate([{ $group: { _id: null, total: { $sum: '$balanceMinor' } } }]),
    ]);
    const topUsers = await User.find({ _id: { $in: top.map((t) => t._id) } }).select('firstName lastName phone').lean();
    const byId = Object.fromEntries(topUsers.map((u) => [String(u._id), u]));
    const statusMap = Object.fromEntries(status.map((s) => [s._id, s.count]));
    const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] || 0), 0);
    res.json({
      period: { from: from.toISOString(), to: new Date(end.getTime() - 1).toISOString() },
      totals: {
        transactions: sum(daily, 'count'),
        moneyOut: fromMinor(sum(daily, 'moneyOut')),
        funding: fromMinor(sum(daily, 'funding')),
        fees: fromMinor(sum(daily, 'fees')),
        failed: statusMap.Failed || 0,
        pending: statusMap.Pending || 0,
        newUsers,
        activeUsers: activeUsers.length,
        walletBalances: fromMinor((balances[0] || {}).total || 0),
      },
      daily: daily.map((d) => ({ date: d._id, count: d.count, moneyOut: fromMinor(d.moneyOut), funding: fromMinor(d.funding), fees: fromMinor(d.fees) })),
      byKind: byKind.map((k) => ({ kind: k._id, count: k.count, volume: fromMinor(k.volume), fees: fromMinor(k.fees) })),
      tiers: tiers.map((t) => ({ tier: t._id, users: t.users, balance: fromMinor(t.balance) })),
      topUsers: top.map((t) => ({ id: String(t._id), name: byId[String(t._id)] ? name(byId[String(t._id)]) : 'Customer', volume: fromMinor(t.volume), count: t.count })),
    });
  }),
);

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get(
  '/reports/export',
  adminOnly,
  validate(S.reportQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { from, end } = range(req.query);
    const rows = await Txn.find({ createdAt: { $gte: from, $lt: end } }).sort({ createdAt: 1 }).limit(20000).lean();
    const head = ['Date', 'Reference', 'Customer', 'Account', 'Type', 'Description', 'Direction', 'Amount', 'Fee', 'Total', 'Status'];
    const lines = [head.join(',')];
    for (const t of rows) {
      const p = present(t);
      lines.push(
        [t.createdAt.toISOString(), t.reference, t.ownerName, t.ownerAccount, t.subtype, p.title, t.direction, (t.amountMinor / 100).toFixed(2), (t.feeMinor / 100).toFixed(2), (t.totalMinor / 100).toFixed(2), t.status]
          .map(csvCell)
          .join(','),
      );
    }
    res.json({ filename: `trustpay-transactions-${from.toISOString().slice(0, 10)}_to_${new Date(end - 1).toISOString().slice(0, 10)}.csv`, count: rows.length, truncated: rows.length === 20000, csv: lines.join('\n') });
  }),
);

module.exports = router;
