'use strict';
const express = require('express');
const env = require('../config/env');
const { User, Otp } = require('../models');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const limits = require('../middleware/limits');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { hashSecret, compareSecret, dummyCompare, hmacHex, randomDigits } = require('../utils/crypto');
const { normalisePhone } = require('../utils/phone');
const { isDuplicateKey } = require('../utils/references');
const sec = require('../services/security');
const { presentUser } = require('../services/presenter');

const router = express.Router();

const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

/** Same wording for unknown user and wrong password, so accounts cannot be probed. */
const badLogin = () => E.unauthorized('Incorrect phone number, email or password.', 'INVALID_CREDENTIALS');

async function findByIdentifier(identifier, select = '') {
  const id = String(identifier).trim();
  const q = id.includes('@') ? { email: id.toLowerCase() } : { phone: normalisePhone(id) };
  if (q.phone === null) return null;
  return User.findOne(q).select(select);
}

/** Sandbox only: hand the code back in the response so the app can be tested without an SMS gateway. Never in live mode. */
const devEcho = (code) => (env.otpDebug && env.providerMode === 'sandbox' ? { devOtp: code } : {});

/** Account numbers are 10 digits and start with 0, for example 0123454821. */
const newAccountNumber = () => `0${randomDigits(9)}`;

router.post(
  '/register',
  limits.auth,
  validate(S.register),
  asyncHandler(async (req, res) => {
    const b = req.body;

    // An abandoned sign-up (phone never verified) must not block the real owner forever.
    const clash = await User.find({ $or: [{ phone: b.phone }, { email: b.email }] }).select('phoneVerified phone email');
    if (clash.some((u) => u.phoneVerified)) {
      const phoneTaken = clash.some((u) => u.phoneVerified && u.phone === b.phone);
      throw E.conflict(
        phoneTaken ? 'An account with this phone number already exists. Try logging in.' : 'An account with this email already exists. Try logging in.',
        phoneTaken ? 'PHONE_TAKEN' : 'EMAIL_TAKEN',
      );
    }
    if (clash.length) {
      const ids = clash.map((u) => u._id);
      await Otp.deleteMany({ user: { $in: ids } });
      await User.deleteMany({ _id: { $in: ids }, phoneVerified: false, balanceMinor: 0 });
    }

    const passwordHash = await hashSecret(b.password);
    let user = null;
    for (let i = 0; i < 8 && !user; i++) {
      try {
        user = await User.create({
          firstName: b.firstName,
          lastName: b.lastName,
          email: b.email,
          phone: b.phone,
          passwordHash,
          accountNumber: newAccountNumber(),
        });
      } catch (err) {
        if (isDuplicateKey(err, 'accountNumber')) continue;
        if (isDuplicateKey(err, 'phone')) throw E.conflict('An account with this phone number already exists. Try logging in.', 'PHONE_TAKEN');
        if (isDuplicateKey(err, 'email')) throw E.conflict('An account with this email already exists. Try logging in.', 'EMAIL_TAKEN');
        throw err;
      }
    }
    if (!user) throw E.unavailable('Could not create your account. Please try again.');

    let code;
    try {
      code = await sec.issueOtp(user, 'verify_phone');
    } catch (err) {
      // The account exists; the app lets the user ask for a new code.
      if (err.status !== 503) throw err;
    }
    res.status(201).json({ token: sec.signSession(user), user: presentUser(user), ...(code ? devEcho(code) : {}) });
  }),
);

router.post(
  '/login',
  limits.auth,
  validate(S.login),
  asyncHandler(async (req, res) => {
    const { identifier, password } = req.body;
    const user = await findByIdentifier(identifier, '+passwordHash');
    if (!user) {
      await dummyCompare(password);
      throw badLogin();
    }
    if (user.loginLockedUntil && user.loginLockedUntil.getTime() > Date.now()) {
      const mins = Math.max(1, Math.ceil((user.loginLockedUntil.getTime() - Date.now()) / 60000));
      throw E.locked(`Too many failed attempts. Try again in ${mins} minutes.`, 'ACCOUNT_LOCKED');
    }
    if (!(await compareSecret(password, user.passwordHash))) {
      const after = await User.findOneAndUpdate({ _id: user._id }, { $inc: { loginFailCount: 1 } }, { new: true }).select('loginFailCount');
      if (after.loginFailCount >= LOGIN_MAX_FAILS) {
        await User.updateOne({ _id: user._id }, { $set: { loginFailCount: 0, loginLockedUntil: new Date(Date.now() + LOGIN_LOCK_MS) } });
        throw E.locked('Too many failed attempts. Try again in 15 minutes.', 'ACCOUNT_LOCKED');
      }
      throw badLogin();
    }
    if (user.status === 'suspended') throw E.forbidden('Your account is suspended. Please contact support.', 'SUSPENDED');
    await User.updateOne({ _id: user._id }, { $set: { loginFailCount: 0, lastLoginAt: new Date() }, $unset: { loginLockedUntil: 1 } });
    res.json({ token: sec.signSession(user), user: presentUser(user) });
  }),
);

/* ---- onboarding (signed in) ---- */

router.post(
  '/otp/send',
  requireAuth,
  limits.otp,
  asyncHandler(async (req, res) => {
    if (req.user.phoneVerified) throw E.conflict('Your phone number is already verified.', 'ALREADY_VERIFIED');
    const code = await sec.issueOtp(req.user, 'verify_phone');
    res.json({ message: 'We sent a code to your phone.', resendIn: 30, ...devEcho(code) });
  }),
);

router.post(
  '/otp/verify',
  requireAuth,
  limits.otp,
  validate(S.otpVerify),
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user.phoneVerified) {
      await sec.checkOtp(user, 'verify_phone', req.body.code);
      user.phoneVerified = true;
      if (user.onboardingStep === 'phone') user.onboardingStep = 'identity';
      await user.save();
    }
    res.json({ user: presentUser(user) });
  }),
);

router.post(
  '/identity',
  requireAuth,
  validate(S.identity),
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user.phoneVerified) throw E.forbidden('Verify your phone number first.', 'PHONE_NOT_VERIFIED');
    if (user.onboardingStep === 'done') throw E.conflict('Your identity is already verified.', 'ALREADY_DONE');
    const b = req.body;

    // The raw ID number is never stored: only a keyed hash (to stop one ID opening many accounts) and the last 4 digits.
    const idNumberHash = hmacHex('id-number', `${b.idType}:${b.idNumber.replace(/\s+/g, '').toUpperCase()}`);
    const used = await User.findOne({ idNumberHash, _id: { $ne: user._id } }).select('_id');
    if (used) throw E.conflict('This ID is already linked to another account.', 'ID_IN_USE');

    user.legalName = b.legalName;
    user.dob = b.dob;
    user.idType = b.idType;
    user.idNumberHash = idNumberHash;
    user.idLast4 = b.idNumber.slice(-4);
    user.address = b.address;
    // TODO(live): send the ID to your KYC provider (e.g. NCRA lookup) and only approve on a match.
    // KYC_MANUAL=true leaves it pending for an admin (Admin > Approvals); otherwise it is approved straight away.
    user.kycStatus = env.kycManual ? 'pending' : 'approved';
    user.kycSubmittedAt = new Date();
    if (user.onboardingStep === 'identity') user.onboardingStep = 'pin';
    await user.save();
    res.json({ user: presentUser(user) });
  }),
);

router.post(
  '/pin',
  requireAuth,
  limits.pin,
  validate(S.setPin),
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (user.onboardingStep !== 'pin') {
      throw E.conflict(user.hasPin ? 'You already have a PIN. Change it from your profile.' : 'Finish the earlier steps first.', 'WRONG_STEP');
    }
    const { pin } = req.body;
    if (/^(\d)\1{3}$/.test(pin) || '01234567890'.includes(pin) || '09876543210'.includes(pin)) {
      throw E.validation('Choose a PIN that is not repeated or in sequence.');
    }
    user.pinHash = await hashSecret(pin);
    user.hasPin = true;
    user.onboardingStep = 'done';
    if (user.kycStatus === 'approved') {
      user.status = 'active';
      user.tier = 'Tier 2 · Verified';
    } // else: stays pending_kyc / Tier 1 until an admin approves; payments stay blocked until then
    await user.save();
    res.json({ user: presentUser(user) });
  }),
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
    res.json({ message: 'Signed out.' });
  }),
);

/* ---- forgot password ---- */

router.post(
  '/forgot',
  limits.auth,
  validate(S.forgot),
  asyncHandler(async (req, res) => {
    const user = await findByIdentifier(req.body.identifier);
    let code;
    if (user && user.status !== 'suspended' && user.phoneVerified) {
      try {
        code = await sec.issueOtp(user, 'reset_password');
      } catch (err) {
        // Cooldown/limit errors are hidden so the response never reveals whether the account exists.
        if (![429, 503].includes(err.status)) throw err;
      }
    }
    res.json({ message: 'If that account exists, we sent a code to its phone.', ...(code ? { devCode: devEcho(code).devOtp } : {}) });
  }),
);

router.post(
  '/forgot/verify',
  limits.auth,
  validate(S.forgotVerify),
  asyncHandler(async (req, res) => {
    const generic = () => E.validation('That code is not correct or has expired.', 'OTP_INVALID');
    const user = await findByIdentifier(req.body.identifier);
    if (!user) throw generic();
    try {
      await sec.checkOtp(user, 'reset_password', req.body.code);
    } catch (err) {
      if (err.status === 422) throw generic(); // same answer for wrong, expired and missing codes
      throw err;
    }
    res.json({ resetToken: sec.signReset(user) });
  }),
);

router.post(
  '/reset',
  limits.auth,
  validate(S.reset),
  asyncHandler(async (req, res) => {
    let payload;
    try {
      payload = sec.verifyToken(req.body.resetToken);
    } catch (_) {
      throw E.validation('This reset link has expired. Please start again.', 'RESET_EXPIRED');
    }
    if (payload.purpose !== 'reset') throw E.validation('This reset link is not valid.', 'RESET_INVALID');
    const user = await User.findById(payload.sub);
    if (!user || (user.tokenVersion || 0) !== payload.tv) throw E.validation('This reset link has already been used.', 'RESET_USED');
    user.passwordHash = await hashSecret(req.body.password);
    user.tokenVersion = (user.tokenVersion || 0) + 1; // signs out every device and kills this token
    user.loginFailCount = 0;
    user.loginLockedUntil = undefined;
    await user.save();
    res.json({ message: 'Your password has been updated.' });
  }),
);

module.exports = router;
