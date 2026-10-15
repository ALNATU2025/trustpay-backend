'use strict';
const express = require('express');
const { User, Approval, Document, TierRequest } = require('../models');
const tiers = require('../services/tiers');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const limits = require('../middleware/limits');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { hashSecret, compareSecret } = require('../utils/crypto');
const { isDuplicateKey } = require('../utils/references');
const { fromMinor } = require('../utils/money');
const sec = require('../services/security');
const { presentUser } = require('../services/presenter');

const router = express.Router();
router.use(requireAuth);

router.get('/me', (req, res) => res.json({ user: presentUser(req.user) }));

router.get('/wallet', (req, res) =>
  res.json({
    balance: fromMinor(req.user.balanceMinor),
    accountNumber: req.user.accountNumber,
    accountName: `${req.user.firstName} ${req.user.lastName}`.trim(),
  }),
);

router.patch(
  '/me',
  validate(S.mePatch),
  asyncHandler(async (req, res) => {
    const user = req.user;
    const b = req.body;
    for (const k of ['firstName', 'lastName', 'email', 'address', 'businessName']) {
      if (b[k] !== undefined) user[k] = b[k];
    }
    try {
      await user.save();
    } catch (err) {
      if (isDuplicateKey(err, 'email')) throw E.conflict('That email is used by another account.', 'EMAIL_TAKEN');
      throw err;
    }
    res.json({ user: presentUser(user) });
  }),
);

router.post(
  '/me/password',
  limits.pin,
  validate(S.mePassword),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!(await compareSecret(req.body.currentPassword, user.passwordHash))) {
      throw E.validation('Your current password is not correct.', 'BAD_PASSWORD');
    }
    user.passwordHash = await hashSecret(req.body.newPassword);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    // The caller's old token is now void; hand back a fresh one so this device stays signed in.
    res.json({ message: 'Your password has been updated.', token: sec.signSession(user) });
  }),
);

router.post(
  '/me/pin',
  limits.pin,
  validate(S.mePin),
  asyncHandler(async (req, res) => {
    await sec.verifyPin(req.user._id, req.body.currentPin);
    const { newPin } = req.body;
    if (/^(\d)\1{3}$/.test(newPin) || '01234567890'.includes(newPin) || '09876543210'.includes(newPin)) {
      throw E.validation('Choose a PIN that is not repeated or in sequence.');
    }
    await User.updateOne({ _id: req.user._id }, { $set: { pinHash: await hashSecret(newPin) } });
    res.json({ message: 'Your PIN has been changed.' });
  }),
);

router.post(
  '/me/pin/verify',
  limits.pin,
  validate(S.mePinVerify),
  asyncHandler(async (req, res) => {
    await sec.verifyPin(req.user._id, req.body.pin);
    res.json({ ok: true });
  }),
);

router.post(
  '/me/limit-request',
  validate(S.limitRequest),
  asyncHandler(async (req, res) => {
    const reason = req.body.reason || '';
    try {
      await Approval.create({
        user: req.user._id,
        type: 'limit',
        title: `${req.user.firstName} ${req.user.lastName} · higher limits`,
        detail: reason ? `Asked for Tier 3. "${reason}"` : 'Asked for Tier 3.',
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw E.conflict('You already have a request waiting for review.', 'ALREADY_REQUESTED');
      throw err;
    }
    res.status(201).json({ message: 'We received your request and will review it soon.' });
  }),
);

/* ---- tiers & upgrade requests ---- */

const NEXT = { 'Tier 1 · Basic': 'Tier 2 · Verified', 'Tier 2 · Verified': 'Tier 3 · Premium' };
const RANK = { 'Tier 1 · Basic': 1, 'Tier 2 · Verified': 2, 'Tier 3 · Premium': 3 };

router.get(
  '/me/tier',
  asyncHandler(async (req, res) => {
    const u = req.user;
    const [all, use, pending, last] = await Promise.all([
      tiers.getLimits(),
      tiers.usage(u),
      TierRequest.findOne({ user: u._id, status: 'pending' }).lean(),
      TierRequest.findOne({ user: u._id, status: 'rejected' }).sort({ createdAt: -1 }).lean(),
    ]);
    const lim = (t) => ({ daily: all[t].dailyMinor == null ? null : fromMinor(all[t].dailyMinor), balance: all[t].balanceMinor == null ? null : fromMinor(all[t].balanceMinor) });
    res.json({
      tier: u.tier,
      limits: lim(u.tier),
      usedToday: fromMinor(use.usedTodayMinor),
      nextTier: NEXT[u.tier] || null,
      all: Object.fromEntries(Object.keys(all).map((t) => [t, lim(t)])),
      pendingRequest: pending ? { id: String(pending._id), tier: pending.tier, createdAt: pending.createdAt } : null,
      lastRejection: last && (!pending) ? { tier: last.tier, reason: last.reason || '' } : null,
    });
  }),
);

const MAGIC = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'application/pdf': [0x25, 0x50, 0x44, 0x46] };

router.post(
  '/me/documents',
  limits.pin,
  validate(S.uploadDocument),
  asyncHandler(async (req, res) => {
    const { kind, mime, data } = req.body;
    const buf = Buffer.from(data, 'base64');
    if (buf.length < 50 || buf.length > 3 * 1024 * 1024) throw E.validation('The file must be 3 MB or smaller.');
    if (!MAGIC[mime].every((b, i) => buf[i] === b)) throw E.validation('That file does not look like a valid JPG, PNG or PDF.');
    const doc = await Document.create({ user: req.user._id, kind, mime, size: buf.length, data: buf });
    res.status(201).json({ document: { id: String(doc._id), kind, mime, size: doc.size } });
  }),
);

router.post(
  '/me/tier-requests',
  limits.pin,
  validate(S.tierRequest),
  asyncHandler(async (req, res) => {
    const u = req.user;
    const b = req.body;
    if (u.status !== 'active') throw E.forbidden('Your account must be approved before you can upgrade.', 'NOT_ACTIVE');
    if (RANK[b.tier] <= RANK[u.tier]) throw E.conflict('You already have this tier or a higher one.', 'ALREADY_THAT_TIER');
    const doc = await Document.findOne({ _id: b.documentId, user: u._id }).select('kind');
    if (!doc) throw E.validation('Upload your document first.');
    if (b.tier === 'Tier 2 · Verified') {
      if (doc.kind !== 'address_proof') throw E.validation('Upload a utility bill as proof of address.');
      if (!b.address) throw E.validation('Enter the address shown on the bill.');
    } else {
      if (doc.kind !== 'business_document') throw E.validation('Upload your business registration document.');
      if (!b.legalName) throw E.validation('Enter your legal company name.');
      if (!b.businessNumber) throw E.validation('Enter your business registration number.');
    }
    try {
      const t = await TierRequest.create({
        user: u._id,
        tier: b.tier,
        address: b.address,
        legalName: b.legalName,
        businessNumber: b.businessNumber,
        document: doc._id,
      });
      require('../services/notify').notifyAdmins('approval', { title: 'Upgrade request', body: `${u.firstName} ${u.lastName} asked for ${b.tier}.`, data: { userId: String(u._id) } });
      res.status(201).json({ message: 'We received your request and will review it soon.', id: String(t._id) });
    } catch (err) {
      if (isDuplicateKey(err)) throw E.conflict('You already have an upgrade request waiting for review.', 'ALREADY_REQUESTED');
      throw err;
    }
  }),
);

module.exports = router;
