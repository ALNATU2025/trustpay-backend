'use strict';
const express = require('express');
const { z } = require('zod');
const { User, SecurityEvent } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const limits = require('../middleware/limits');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { hashSecret, compareSecret } = require('../utils/crypto');
const sec = require('../services/security');
const audit = require('../services/audit');
const notify = require('../services/notify');
const S = require('../validators/schemas');

const router = express.Router();
router.use(requireAuth);

const weakPin = (p) => /^(\d)\1{3}$/.test(p) || '01234567890'.includes(p) || '09876543210'.includes(p);
const LABEL = {
  login: 'Signed in',
  new_device: 'New device signed in',
  pin_changed: 'PIN changed',
  pin_reset: 'PIN reset with password',
  password_changed: 'Password changed',
  sessions_revoked: 'Signed out of all devices',
};

router.get(
  '/me/security',
  asyncHandler(async (req, res) => {
    const u = await User.findById(req.user._id).select('hasPin pinLockedUntil lastLoginAt').lean();
    const rows = await SecurityEvent.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(25).lean();
    res.json({
      hasPin: !!u.hasPin,
      pinLockedUntil: u.pinLockedUntil && u.pinLockedUntil > new Date() ? u.pinLockedUntil.toISOString() : null,
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      events: rows.map((e) => ({ id: String(e._id), type: e.type, title: LABEL[e.type] || e.type, at: e.createdAt.toISOString(), note: e.note || '' })),
    });
  }),
);

/** Forgot the PIN: set a new one by proving the account password. Also lifts a PIN lock. */
router.post(
  '/me/pin/reset',
  limits.pin,
  validate(S.pinReset),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!(await compareSecret(req.body.password, user.passwordHash))) throw E.validation('Your password is not correct.', 'BAD_PASSWORD');
    if (weakPin(req.body.newPin)) throw E.validation('Choose a PIN that is not repeated or in sequence.');
    await User.updateOne({ _id: user._id }, { $set: { pinHash: await hashSecret(req.body.newPin), hasPin: true, pinFailCount: 0 }, $unset: { pinLockedUntil: 1 } });
    await audit.record(req, user._id, 'pin_reset');
    notify.notifyUser(user._id, { type: 'security', title: 'PIN reset', body: 'Your transaction PIN was reset. If this was not you, contact support now.' });
    res.json({ message: 'Your PIN has been reset.' });
  }),
);

/** Lost phone? Signs out every device. This device gets a fresh token and stays signed in. */
router.post(
  '/me/sessions/revoke-all',
  limits.pin,
  validate(S.passwordOnly),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!(await compareSecret(req.body.password, user.passwordHash))) throw E.validation('Your password is not correct.', 'BAD_PASSWORD');
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await audit.record(req, user._id, 'sessions_revoked');
    res.json({ message: 'All other devices have been signed out.', token: sec.signSession(user) });
  }),
);

module.exports = router;
