'use strict';
const express = require('express');
const { User, Txn, Ticket, Message, Approval, TerminalRequest, Terminal, TierRequest, Document } = require('../models');
const tiers = require('../services/tiers');
const PosPayment = require('../models/PosPayment');
const Settlement = require('../models/Settlement');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { CODES, isDuplicateKey } = require('../utils/references');
const { fromMinor } = require('../utils/money');
const { randomDigits } = require('../utils/crypto');
const { startOfDayUtc, addDays, DAYS } = require('../utils/time');
const { applyExternalCredit, debitWallet, fullName, searchText } = require('../services/wallet');
const { createWithReference, CODES: REF_CODES, isDuplicateKey: isDup } = require('../utils/references');
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

/** Admin ledger row: the customer-facing row plus who owns it and why it needs attention. */
const adminTxn = (t) => ({
  ...present(t),
  userId: String(t.user),
  owner: t.ownerName || '',
  ownerAccount: t.ownerAccount || '',
  reference: t.reference,
  subtype: t.subtype,
  provider: t.providerRef || '',
  failureReason: t.failureReason || '',
  needsReview: !!t.needsReview,
});

router.get(
  '/transactions',
  validate(S.adminTxnQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const f = buildFilter(q, {});
    if (q.direction) f.direction = q.direction;
    if (q.user) f.user = q.user;
    if (q.review) f.needsReview = true;
    const rows = await Txn.find(f).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit + 1).lean();
    res.json({ items: rows.slice(0, q.limit).map(adminTxn), page: q.page, hasMore: rows.length > q.limit });
  }),
);

/* ---- user detail + manual funding ---- */

const adminUserDetail = (u) => ({
  ...adminUser(u),
  email: u.email || '',
  role: u.role,
  balance: fromMinor(u.balanceMinor),
  kycStatus: u.kycStatus,
  onboardingStep: u.onboardingStep,
  accountNumber: u.accountNumber || '',
  merchantCode: u.merchantCode || '',
  settlementAccount: u.settlementAccount && u.settlementAccount.accountNumber ? `${u.settlementAccount.bank} •• ${String(u.settlementAccount.accountNumber).slice(-4)} (${u.settlementTo === 'bank' ? 'pays to bank' : 'stays in wallet'})` : '',
  lastLoginAt: iso(u.lastLoginAt),
  createdAt: iso(u.createdAt),
  locked: !!(u.pinLockedUntil && u.pinLockedUntil > new Date()),
});

router.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const u = await User.findById(req.params.id).lean();
    if (!u) throw E.notFound('User not found.');
    const [recent, term] = await Promise.all([
      Txn.find({ user: u._id }).sort({ createdAt: -1, _id: -1 }).limit(10).lean(),
      Terminal.findOne({ owner: u._id }).lean(),
    ]);
    res.json({ user: adminUserDetail(u), recent: recent.map(adminTxn), hasTerminal: !!term });
  }),
);

router.post(
  '/users/:id/unlock',
  adminOnly,
  asyncHandler(async (req, res) => {
    const u = await User.findOneAndUpdate({ _id: req.params.id, role: 'user' }, { $set: { pinFailCount: 0 }, $unset: { pinLockedUntil: 1 } }, { new: true });
    if (!u) throw E.notFound('User not found.');
    audit(req, 'user.unlock', { target: String(u._id) });
    res.json({ user: adminUserDetail(u) });
  }),
);

router.post(
  '/users/:id/funding',
  adminOnly,
  validate(S.fundingManual),
  asyncHandler(async (req, res) => {
    const { type, amount, reason, key } = req.body;
    const target = await User.findById(req.params.id).select('firstName lastName accountNumber balanceMinor role status');
    if (!target) throw E.notFound('User not found.');
    if (String(target._id) === String(req.user._id)) throw E.forbidden('You cannot adjust your own balance.');
    if (target.role !== 'user') throw E.forbidden('Staff accounts cannot be adjusted here.');
    const externalRef = `manual:${req.user._id}:${key}`;
    const details = { reason, by: String(req.user._id), byName: fullName(req.user) };

    let txn;
    let balanceMinor;
    let duplicate = false;
    if (type === 'credit') {
      const r = await applyExternalCredit({
        userId: target._id,
        kind: 'funding',
        subtype: 'manual_credit',
        code: REF_CODES.funding,
        amountMinor: amount,
        details,
        externalRef,
      });
      txn = r.txn;
      balanceMinor = r.balanceMinor;
      duplicate = !!r.duplicate;
    } else {
      // Debit: write the row first (unique externalRef makes a retry safe), then move the money atomically.
      try {
        txn = (
          await createWithReference(Txn, REF_CODES.transfer, (reference) => ({
            user: target._id,
            reference,
            kind: 'funding',
            subtype: 'manual_debit',
            direction: 'debit',
            amountMinor: amount,
            feeMinor: 0,
            totalMinor: amount,
            status: 'Pending',
            details,
            ownerName: fullName(target),
            ownerAccount: target.accountNumber,
            search: searchText([reference, 'manual debit adjustment', reason]),
            externalRef,
          }))
        ).toObject();
      } catch (err) {
        if (!isDup(err, 'externalRef')) throw err;
        txn = await Txn.findOne({ externalRef }).lean();
        duplicate = true;
      }
      if (!duplicate) {
        const after = await debitWallet(target._id, amount);
        if (!after) {
          await Txn.updateOne({ _id: txn._id }, { $set: { status: 'Failed', failureReason: 'Insufficient balance.' } });
          throw E.badRequest('The customer does not have enough balance for this debit.');
        }
        balanceMinor = after.balanceMinor;
        await Txn.updateOne({ _id: txn._id }, { $set: { status: 'Successful', debited: true, balanceAfterMinor: balanceMinor } });
        txn = await Txn.findById(txn._id).lean();
      } else {
        balanceMinor = (await User.findById(target._id).select('balanceMinor')).balanceMinor;
      }
    }
    audit(req, `funding.${type}`, { target: String(target._id), amountMinor: amount, reason, ref: txn && txn.reference, duplicate });
    res.json({ transaction: adminTxn(txn), balance: fromMinor(balanceMinor), duplicate });
  }),
);

/* ---- merchants / POS ---- */

router.get(
  '/pos/overview',
  asyncHandler(async (req, res) => {
    const [terminals, payments, processing, paid, pendingReq] = await Promise.all([
      Terminal.countDocuments({ status: 'active' }),
      PosPayment.aggregate([{ $group: { _id: null, total: { $sum: '$amountMinor' }, count: { $sum: 1 } } }]),
      Settlement.aggregate([{ $match: { status: 'Processing' } }, { $group: { _id: null, net: { $sum: '$netMinor' }, count: { $sum: 1 } } }]),
      Settlement.aggregate([{ $match: { status: 'Paid' } }, { $group: { _id: null, net: { $sum: '$netMinor' }, count: { $sum: 1 } } }]),
      TerminalRequest.countDocuments({ status: 'pending' }),
    ]);
    const p = payments[0] || { total: 0, count: 0 };
    res.json({
      activeTerminals: terminals,
      pendingRequests: pendingReq,
      paymentsCount: p.count,
      paymentsVolume: fromMinor(p.total),
      payoutsProcessing: fromMinor((processing[0] || {}).net || 0),
      payoutsProcessingCount: (processing[0] || {}).count || 0,
      payoutsPaid: fromMinor((paid[0] || {}).net || 0),
      payoutsPaidCount: (paid[0] || {}).count || 0,
    });
  }),
);

async function ownerNames(ids) {
  const users = await User.find({ _id: { $in: [...new Set(ids.map(String))] } }).select('firstName lastName').lean();
  return Object.fromEntries(users.map((u) => [String(u._id), `${u.firstName} ${u.lastName}`.trim()]));
}

router.get(
  '/pos/terminals',
  validate(S.posQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { owner, status, page, limit } = req.query;
    const f = {};
    if (owner) f.owner = owner;
    if (status === 'active' || status === 'disabled') f.status = status;
    const rows = await Terminal.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit + 1).lean();
    const items = rows.slice(0, limit);
    const names = await ownerNames(items.map((t) => t.owner));
    res.json({
      items: items.map((t) => ({
        id: String(t._id),
        code: t.code,
        serial: t.serial,
        status: t.status,
        businessName: t.businessName || '',
        location: t.location || '',
        ownerId: String(t.owner),
        owner: names[String(t.owner)] || '',
        lastSync: iso(t.lastSyncAt),
      })),
      page,
      hasMore: rows.length > limit,
    });
  }),
);

router.get(
  '/pos/payments',
  validate(S.posQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { owner, q, page, limit } = req.query;
    const f = {};
    if (owner) f.owner = owner;
    if (q) f.$or = [{ reference: { $regex: escapeRe(q) } }, { terminalCode: { $regex: escapeRe(q.toUpperCase()) } }, { payer: { $regex: escapeRe(q), $options: 'i' } }];
    const rows = await PosPayment.find(f).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit + 1).lean();
    const items = rows.slice(0, limit);
    const names = await ownerNames(items.map((p) => p.owner));
    res.json({
      items: items.map((p) => ({
        id: String(p._id),
        reference: p.reference,
        terminalCode: p.terminalCode,
        ownerId: String(p.owner),
        owner: names[String(p.owner)] || '',
        kind: p.kind,
        payer: p.payer || '',
        amount: fromMinor(p.amountMinor),
        settled: !!p.settled,
        createdAt: iso(p.createdAt),
      })),
      page,
      hasMore: rows.length > limit,
    });
  }),
);

router.get(
  '/pos/settlements',
  validate(S.posQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { owner, status, page, limit } = req.query;
    const f = {};
    if (owner) f.owner = owner;
    if (status === 'Processing' || status === 'Paid') f.status = status;
    const rows = await Settlement.find(f).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit + 1).lean();
    const items = rows.slice(0, limit);
    const names = await ownerNames(items.map((s) => s.owner));
    res.json({
      items: items.map((s) => ({
        id: String(s._id),
        reference: s.reference,
        ownerId: String(s.owner),
        owner: names[String(s.owner)] || '',
        gross: fromMinor(s.grossMinor),
        fee: fromMinor(s.feeMinor),
        net: fromMinor(s.netMinor),
        count: s.count,
        status: s.status,
        destination: s.destination,
        scheduledFor: iso(s.scheduledFor),
        settledAt: iso(s.settledAt),
      })),
      page,
      hasMore: rows.length > limit,
    });
  }),
);

/* ---- approvals: ids are prefixed by kind (lim_, pos_, kyc_) ---- */

router.get(
  '/approvals',
  asyncHandler(async (req, res) => {
    const [limits, pos, kyc, tierReqs] = await Promise.all([
      Approval.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(50).lean(),
      TerminalRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(50).lean(),
      User.find({ kycStatus: 'pending' }).sort({ kycSubmittedAt: 1 }).limit(50).lean(),
      TierRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(50).lean(),
    ]);
    const reqUsers = await User.find({ _id: { $in: tierReqs.map((t) => t.user) } }).select('firstName lastName').lean();
    const nameOf = Object.fromEntries(reqUsers.map((u) => [String(u._id), `${u.firstName} ${u.lastName}`.trim()]));
    const items = [
      ...tierReqs.map((t) => ({
        id: `tier_${t._id}`,
        type: 'tier',
        title: `${nameOf[String(t.user)] || 'Customer'} · upgrade to ${t.tier.split(' · ')[0]}`,
        detail: t.tier.startsWith('Tier 2') ? `Address: ${t.address || '—'}` : `${t.legalName || '—'} · Reg. no ${t.businessNumber || '—'}`,
        documentId: String(t.document),
        userId: String(t.user),
        createdAt: iso(t.createdAt),
      })),
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
      const a = await Approval.findOne({ _id: rawId, status: 'pending' });
      if (!a) throw E.notFound('This request was already handled.');
      if (approve) await User.updateOne({ _id: a.user }, { $set: { tier: a.requestedTier } }); // idempotent, done first
      await Approval.updateOne({ _id: a._id, status: 'pending' }, { $set: { status: approve ? 'approved' : 'rejected', ...decided } });
    } else if (kind === 'pos') {
      const intent = approve ? 'approve' : 'reject';
      // Claim the request. The same admin may retry the same decision after a crash; nobody else can flip it.
      const r = await TerminalRequest.findOneAndUpdate(
        { _id: rawId, status: 'pending', $or: [{ decisionIntent: null }, { decisionIntent: intent, decidedBy: req.user._id }] },
        { $set: { decisionIntent: intent, decidedBy: req.user._id } },
        { new: true },
      );
      if (!r) throw E.notFound('This request was already handled.');
      if (approve) {
        const t = (await Terminal.findOne({ owner: r.user })) || (await newTerminal(r));
        await TerminalRequest.updateOne({ _id: r._id }, { $set: { status: 'approved', terminal: t._id, decidedAt: new Date(), reason } });
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
        await TerminalRequest.updateOne({ _id: r._id }, { $set: { status: 'rejected', refundedAt: new Date(), decidedAt: new Date(), reason } });
      }
    } else if (kind === 'kyc') {
      const u = await User.findOneAndUpdate(
        { _id: rawId, kycStatus: 'pending' },
        { $set: { kycStatus: approve ? 'approved' : 'rejected', kycReason: reason, ...(approve ? { status: 'active', tier: 'Tier 1 · Basic' } : {}) } },
      );
      if (!u) throw E.notFound('This request was already handled.');
    } else if (kind === 'tier') {
      const t = await TierRequest.findOne({ _id: rawId, status: 'pending' });
      if (!t) throw E.notFound('This request was already handled.');
      if (approve) {
        await User.updateOne({ _id: t.user }, { $set: { tier: t.tier, ...(t.tier.startsWith('Tier 2') && t.address ? { address: t.address } : {}), ...(t.tier.startsWith('Tier 3') && t.legalName ? { businessName: t.legalName } : {}) } });
      }
      await TierRequest.updateOne({ _id: t._id, status: 'pending' }, { $set: { status: approve ? 'approved' : 'rejected', ...decided } });
    } else {
      throw E.notFound('Approval not found.');
    }
    audit(req, 'approval.decision', { id: req.params.id, approve });
    res.json({ ok: true });
  }),
);

/* ---- proof documents and tier limits ---- */

router.get(
  '/documents/:id',
  asyncHandler(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw E.notFound('Document not found.');
    const d = await Document.findById(req.params.id).select('+data').lean();
    if (!d) throw E.notFound('Document not found.');
    audit(req, 'document.view', { id: String(d._id), owner: String(d.user) });
    res.json({ id: String(d._id), kind: d.kind, mime: d.mime, size: d.size, data: Buffer.from(d.data.buffer || d.data).toString('base64') });
  }),
);

const presentLimits = (all) =>
  Object.fromEntries(Object.entries(all).map(([t, l]) => [t, { daily: l.dailyMinor == null ? null : fromMinor(l.dailyMinor), balance: l.balanceMinor == null ? null : fromMinor(l.balanceMinor) }]));

router.get(
  '/tiers',
  asyncHandler(async (req, res) => {
    const counts = await User.aggregate([{ $match: { role: 'user' } }, { $group: { _id: '$tier', n: { $sum: 1 } } }]);
    res.json({ limits: presentLimits(await tiers.getLimits()), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
  }),
);

router.put(
  '/tiers',
  adminOnly,
  validate(S.tierLimits),
  asyncHandler(async (req, res) => {
    const next = {};
    for (const [t, v] of Object.entries(req.body)) {
      next[t] = {};
      if ('daily' in v) next[t].dailyMinor = v.daily;
      if ('balance' in v) next[t].balanceMinor = v.balance;
    }
    const saved = await tiers.setLimits(next);
    audit(req, 'tiers.update', { limits: JSON.stringify(next) });
    res.json({ limits: presentLimits(saved) });
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
