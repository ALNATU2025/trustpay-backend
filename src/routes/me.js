'use strict';
const express = require('express');
const { User, Approval } = require('../models');
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

module.exports = router;
