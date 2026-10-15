'use strict';
const express = require('express');
const { Txn, Recipient } = require('../models');
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
  transfer: ['transfer', 'mobile_money'],
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
