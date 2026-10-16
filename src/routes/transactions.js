'use strict';
const express = require('express');
const { Txn, Recipient, User } = require('../models');
const { fromMinor } = require('../utils/money');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { present } = require('../services/presenter');
const { refreshPending } = require('../services/monime');

const router = express.Router();
router.use(requireAuth);

const SERVICE_KINDS = {
  transfer: ['transfer', 'mobile_money', 'agent'],
  bill: ['bill', 'tv', 'internet'],
  airtime: ['airtime', 'data'],
  funding: ['funding'],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Builds the Mongo filter for the history screen. `scope` is fixed per caller (own vs all users). */
function buildFilter(q, scope) {
  const f = { ...scope };
  if (q.service && q.service !== 'all') f.kind = { $in: SERVICE_KINDS[q.service] };
  if (q.status) f.status = q.status;
  if (q.q) f.search = { $regex: escapeRe(q.q.toLowerCase()) };
  if (q.from || q.to) {
    f.createdAt = {};
    if (q.from) f.createdAt.$gte = q.from;
    if (q.to) f.createdAt.$lte = q.to;
  }
  return f;
}

async function listPage(filter, q) {
  const rows = await Txn.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip((q.page - 1) * q.limit)
    .limit(q.limit + 1)
    .lean();
  return { items: rows.slice(0, q.limit).map(present), page: q.page, hasMore: rows.length > q.limit };
}

router.get(
  '/transactions',
  validate(S.txnQuery, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await listPage(buildFilter(req.query, { user: req.user._id }), req.query));
  }),
);

/** Account statement for a period: opening/closing balance, totals and every entry. */
router.get(
  '/statement',
  validate(S.statementQuery, 'query'),
  asyncHandler(async (req, res) => {
    const me = req.user;
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
    const from = req.query.from ? new Date(Date.UTC(req.query.from.getUTCFullYear(), req.query.from.getUTCMonth(), req.query.from.getUTCDate())) : new Date(end.getTime() - 30 * 86400000);
    if (from >= end) throw E.validation('The start date must be before the end date.');
    if (end - from > 366 * 86400000) throw E.validation('Choose a period of one year or less.');

    // Money really moved when a credit succeeded, or a debit was taken (a failed payment is refunded by its own reversal row).
    const moved = (t) => (t.direction === 'credit' ? t.status === 'Successful' : t.debited || t.status === 'Successful');
    const net = (rows) => rows.reduce((a, t) => a + (moved(t) ? (t.direction === 'credit' ? t.totalMinor : -t.totalMinor) : 0), 0);

    const [rows, after] = await Promise.all([
      Txn.find({ user: me._id, createdAt: { $gte: from, $lt: end } }).sort({ createdAt: 1, _id: 1 }).limit(3000).lean(),
      Txn.find({ user: me._id, createdAt: { $gte: end } }).select('direction status debited totalMinor').lean(),
    ]);
    const cur = (await User.findById(me._id).select('balanceMinor').lean()).balanceMinor;
    const closing = cur - net(after);
    const opening = closing - net(rows);

    let running = opening;
    let totalIn = 0;
    let totalOut = 0;
    let totalFees = 0;
    const items = rows.map((t) => {
      const p = present(t);
      const did = moved(t);
      const credit = t.direction === 'credit';
      if (did) {
        running += credit ? t.totalMinor : -t.totalMinor;
        if (credit) totalIn += t.totalMinor;
        else {
          totalOut += t.totalMinor;
          totalFees += t.feeMinor || 0;
        }
      }
      return {
        date: t.createdAt.toISOString(),
        reference: t.reference,
        description: p.title,
        status: t.status,
        debit: !credit && did ? fromMinor(t.totalMinor) : 0,
        credit: credit && did ? fromMinor(t.totalMinor) : 0,
        balance: fromMinor(running),
      };
    });
    const out = {
      account: { name: `${me.firstName} ${me.lastName}`.trim(), accountNumber: me.accountNumber },
      period: { from: from.toISOString(), to: new Date(end.getTime() - 1).toISOString() },
      openingBalance: fromMinor(opening),
      closingBalance: fromMinor(closing),
      totalIn: fromMinor(totalIn),
      totalOut: fromMinor(totalOut),
      totalFees: fromMinor(totalFees),
      count: items.length,
      truncated: rows.length === 3000,
      items,
    };
    if (req.query.format === 'csv') {
      const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const lines = ['Date,Reference,Description,Status,Money out,Money in,Balance'];
      for (const i of items) lines.push([i.date.slice(0, 16).replace('T', ' '), i.reference, i.description, i.status, i.debit.toFixed(2), i.credit.toFixed(2), i.balance.toFixed(2)].map(cell).join(','));
      return res.json({ filename: `trustpay-statement-${from.toISOString().slice(0, 10)}_to_${new Date(end - 1).toISOString().slice(0, 10)}.csv`, csv: lines.join('\n') });
    }
    return res.json(out);
  }),
);

router.get(
  '/transactions/:id',
  asyncHandler(async (req, res) => {
    let t = await Txn.findOne({ _id: req.params.id, user: req.user._id }).lean();
    if (!t) throw E.notFound('We could not find that transaction.');
    if (t.status === 'Pending') {
      const r = await refreshPending(t);
      if (r && r.changed) t = await Txn.findById(t._id).lean();
    }
    res.json({ transaction: present(t) });
  }),
);

router.get(
  '/recipients',
  asyncHandler(async (req, res) => {
    const rows = await Recipient.find({ user: req.user._id }).sort({ updatedAt: -1 }).limit(50).lean();
    res.json({ items: rows.map((r) => ({ id: String(r._id), bank: r.bank, accountNumber: r.accountNumber, accountName: r.accountName })) });
  }),
);

router.delete(
  '/recipients/:id',
  asyncHandler(async (req, res) => {
    await Recipient.deleteOne({ _id: req.params.id, user: req.user._id });
    res.json({ ok: true });
  }),
);

module.exports = router;
module.exports.buildFilter = buildFilter;
module.exports.listPage = listPage;
