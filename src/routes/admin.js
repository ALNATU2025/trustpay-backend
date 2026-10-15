'use strict';
const express = require('express');
const { User, Txn, Ticket, Message, Approval, TerminalRequest, Terminal } = require('../models');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { CODES, isDuplicateKey } = require('../utils/references');
const { fromMinor } = require('../utils/money');
const { randomDigits } = require('../utils/crypto');
const { startOfDayUtc, addDays, DAYS } = require('../utils/time');
const { applyExternalCredit } = require('../services/wallet');
const { present, presentTicket, presentMessage, iso } = require('../services/presenter');
const { buildFilter, listPage } = require('./transactions');
const { addMessage } = require('./support');
const log = require('../utils/log');
const { normalisePhone, formatLocal } = require('../utils/phone');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'support'));
const adminOnly = requireRole('admin');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const audit = (req, action, meta) => log.info(`audit:${action}`, { by: String(req.user._id), ...meta });

const adminUser = (u) => ({ id: String(u._id), name: `${u.firstName} ${u.lastName}`.trim(), phone: formatLocal(u.phone), tier: u.tier, status: u.status });

/** Sum of successful money-out per UTC day, between [from, to). */
async function dayTotals(from, to) {
  const rows = await Txn.aggregate([
    { $match: { direction: 'debit', status: 'Successful', createdAt: { $gte: from, $lt: to } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$totalMinor' } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, r.total]));
}

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const today = startOfDayUtc();
    const weekStart = addDays(today, -6);
    const [totalUsers, activeToday, pendingLimit, pendingPos, pendingKyc, openTickets, totals] = await Promise.all([
      User.countDocuments({ role: 'user' }),
      User.countDocuments({ lastLoginAt: { $gte: today } }),
      Approval.countDocuments({ status: 'pending' }),
      TerminalRequest.countDocuments({ status: 'pending' }),
      User.countDocuments({ kycStatus: 'pending' }),
      Ticket.countDocuments({ status: 'open' }),
      dayTotals(weekStart, addDays(today, 1)),
    ]);
    const key = (d) => d.toISOString().slice(0, 10);
    const week = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      week.push({ label: DAYS[d.getUTCDay()], value: fromMinor(totals[key(d)] || 0) });
    }
    const t = totals[key(today)] || 0;
    const y = totals[key(addDays(today, -1))] || 0;
    res.json({
      totalUsers,
      activeToday,
      pendingApprovals: pendingLimit + pendingPos + pendingKyc,
      openTickets,
      volumeToday: fromMinor(t),
      volumeYesterday: fromMinor(y),
      changePct: y > 0 ? Math.round(((t - y) / y) * 1000) / 10 : 0,
      week,
    });
  }),
);

router.get(
  '/users',
  validate(S.listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { q, page, limit } = req.query;
    const f = {};
    if (q) {
      const digits = q.replace(/\D/g, '');
      f.$or = [{ searchName: { $regex: escapeRe(q.toLowerCase()) } }, { email: { $regex: escapeRe(q.toLowerCase()) } }];
      if (digits.length >= 4) f.$or.push({ accountNumber: digits }, { phone: normalisePhone(digits) || digits.slice(-8) });
    }
    const rows = await User.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit + 1).lean();
    res.json({ items: rows.slice(0, limit).map(adminUser), page, hasMore: rows.length > limit });
  }),
);

router.patch(
  '/users/:id',
  adminOnly,
  validate(S.adminUserPatch),
  asyncHandler(async (req, res) => {
    const u = await User.findById(req.params.id);
    if (!u) throw E.notFound('User not found.');
    if (String(u._id) === String(req.user._id)) throw E.forbidden('You cannot change your own account here.');
    if (u.role !== 'user') throw E.forbidden('Staff accounts cannot be changed here.');
    if (req.body.status) {
      u.status = req.body.status;
      if (req.body.status === 'suspended') u.tokenVersion = (u.tokenVersion || 0) + 1; // sign them out everywhere
    }
    if (req.body.tier) u.tier = req.body.tier;
    await u.save();
    audit(req, 'user.update', { target: String(u._id), status: req.body.status, tier: req.body.tier });
    res.json({ user: adminUser(u) });
  }),
);

router.get(
  '/transactions',
  validate(S.txnQuery, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await listPage(buildFilter(req.query, {}), req.query));
  }),
);

/* ---- approvals: ids are prefixed by kind (lim_, pos_, kyc_) ---- */

router.get(
  '/approvals',
  asyncHandler(async (req, res) => {
    const [limits, pos, kyc] = await Promise.all([
      Approval.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(50).lean(),
      TerminalRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(50).lean(),
      User.find({ kycStatus: 'pending' }).sort({ kycSubmittedAt: 1 }).limit(50).lean(),
    ]);
    const items = [
      ...limits.map((a) => ({ id: `lim_${a._id}`, type: 'limit', title: a.title, detail: a.detail, createdAt: iso(a.createdAt) })),
      ...pos.map((r) => ({
        id: `pos_${r._id}`,
        type: 'pos',
        title: `${r.businessName} · POS terminal`,
        detail: `${[r.address, r.city, r.state].filter(Boolean).join(', ')} · ${r.reference}`,
        createdAt: iso(r.createdAt),
      })),
      ...kyc.map((u) => ({
        id: `kyc_${u._id}`,
        type: 'kyc',
        title: `${u.firstName} ${u.lastName} · identity check`,
        detail: `${u.idType || 'ID'} •• ${u.idLast4 || ''}`,
        createdAt: iso(u.kycSubmittedAt || u.createdAt),
      })),
    ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    res.json({ items });
  }),
);

async function newTerminal(request) {
  for (let i = 0; i < 20; i++) {
    try {
      return await Terminal.create({
        owner: request.user,
        code: `TP-${randomDigits(4)}`,
        serial: `SN${randomDigits(9)}`,
        businessName: request.businessName,
        location: [request.city, request.state].filter(Boolean).join(', '),
        request: request._id,
      });
    } catch (err) {
      if (isDuplicateKey(err, 'owner')) throw E.conflict('This customer already has a terminal.', 'TERMINAL_EXISTS');
      if (!isDuplicateKey(err)) throw err;
    }
  }
  throw E.unavailable('Could not allocate a terminal code. Try again.');
}

router.post(
  '/approvals/:id/decision',
  adminOnly,
  validate(S.decision),
  asyncHandler(async (req, res) => {
    const [kind, rawId] = String(req.params.id).split(/_(.+)/);
    const { approve, reason } = req.body;
    const decided = { decidedBy: req.user._id, decidedAt: new Date(), reason };

    if (kind === 'lim') {
      const a = await Approval.findOneAndUpdate({ _id: rawId, status: 'pending' }, { $set: { status: approve ? 'approved' : 'rejected', ...decided } }, { new: true });
      if (!a) throw E.notFound('This request was already handled.');
      if (approve) await User.updateOne({ _id: a.user }, { $set: { tier: a.requestedTier } });
    } else if (kind === 'pos') {
      const r = await TerminalRequest.findOneAndUpdate({ _id: rawId, status: 'pending' }, { $set: { status: approve ? 'approved' : 'rejected', ...decided } }, { new: true });
      if (!r) throw E.notFound('This request was already handled.');
      if (approve) {
        const t = await newTerminal(r);
        await TerminalRequest.updateOne({ _id: r._id }, { $set: { terminal: t._id } });
      } else {
        // Money back: deposit and delivery. Keyed by the request, so a retry cannot refund twice.
        await applyExternalCredit({
          userId: r.user,
          kind: 'pos',
          subtype: 'pos_refund',
          code: CODES.pos,
          amountMinor: r.depositMinor + r.deliveryMinor,
          details: { reason: reason || 'Your POS request was not approved.' },
          externalRef: `posrefund:${r._id}`,
        });
        await TerminalRequest.updateOne({ _id: r._id }, { $set: { refundedAt: new Date() } });
      }
    } else if (kind === 'kyc') {
      const u = await User.findOneAndUpdate(
        { _id: rawId, kycStatus: 'pending' },
        { $set: { kycStatus: approve ? 'approved' : 'rejected', kycReason: reason, ...(approve ? { status: 'active' } : {}) } },
      );
      if (!u) throw E.notFound('This request was already handled.');
    } else {
      throw E.notFound('Approval not found.');
    }
    audit(req, 'approval.decision', { id: req.params.id, approve });
    res.json({ ok: true });
  }),
);

/* ---- tickets ---- */

router.get(
  '/tickets',
  validate(S.adminTicketsQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { status, type, page, limit } = req.query;
    const f = { ...(status ? { status } : {}), ...(type ? { type } : {}) };
    const rows = await Ticket.find(f).sort({ lastMessageAt: -1 }).skip((page - 1) * limit).limit(limit + 1).lean();
    const page_ = rows.slice(0, limit);
    const users = await User.find({ _id: { $in: page_.map((t) => t.user) } }).select('firstName lastName').lean();
    const byId = Object.fromEntries(users.map((u) => [String(u._id), u]));
    res.json({ items: page_.map((t) => presentTicket(t, { withUser: true, user: byId[String(t.user)] })), page, hasMore: rows.length > limit });
  }),
);

router.get(
  '/tickets/:id',
  asyncHandler(async (req, res) => {
    const t = await Ticket.findById(req.params.id).lean();
    if (!t) throw E.notFound('Conversation not found.');
    const [u, msgs] = await Promise.all([User.findById(t.user).select('firstName lastName').lean(), Message.find({ ticket: t._id }).sort({ createdAt: 1, _id: 1 }).limit(500).lean()]);
    res.json({ ticket: presentTicket(t, { withUser: true, user: u }), messages: msgs.map(presentMessage) });
  }),
);

router.post(
  '/tickets/:id/reply',
  validate(S.message),
  asyncHandler(async (req, res) => {
    const t = await Ticket.findById(req.params.id);
    if (!t) throw E.notFound('Conversation not found.');
    if (t.status === 'closed') throw E.conflict('This conversation is closed.', 'TICKET_CLOSED');
    const msg = await addMessage(t, { from: 'agent', text: req.body.text, author: req.user._id });
    res.status(201).json({ message: presentMessage(msg) });
  }),
);

router.post(
  '/tickets/:id/close',
  asyncHandler(async (req, res) => {
    const t = await Ticket.findByIdAndUpdate(req.params.id, { $set: { status: 'closed', closedBy: req.user._id } }, { new: true });
    if (!t) throw E.notFound('Conversation not found.');
    res.json({ ticket: presentTicket(t) });
  }),
);

module.exports = router;
