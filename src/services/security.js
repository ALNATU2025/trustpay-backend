'use strict';
/** PIN verification with lock-out, OTP issue/verify, and JWT helpers. */
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User, Otp } = require('../models');
const providers = require('../providers');
const { E } = require('../utils/errors');
const { compareSecret } = require('../utils/crypto');
const otp = require('../utils/otp');
const log = require('../utils/log');

const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 30 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_S = 30;
const OTP_PER_HOUR = 5;

/* ------------------------------------------------------------------ tokens */

const signSession = (user) => jwt.sign({ sub: String(user._id), tv: user.tokenVersion || 0 }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

const signReset = (user) =>
  jwt.sign({ sub: String(user._id), tv: user.tokenVersion || 0, purpose: 'reset' }, env.jwtSecret, { expiresIn: '10m' });

const verifyToken = (token) => jwt.verify(token, env.jwtSecret);

/* --------------------------------------------------------------------- PIN */

const minutesLeft = (until) => Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000));

// Per-user queue: PIN checks for one customer run one at a time inside this process, so a burst of
// parallel guesses is counted (and locked out) in order instead of all slipping past the lock check.
const queues = new Map();
function serialize(key, fn) {
  const run = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

async function verifyPinOnce(userId, pin) {
  const u = await User.findById(userId).select('+pinHash pinFailCount pinLockedUntil hasPin');
  if (!u || !u.hasPin || !u.pinHash) throw E.forbidden('Set your transaction PIN first.', 'PIN_NOT_SET');
  if (u.pinLockedUntil && u.pinLockedUntil.getTime() > Date.now()) {
    throw E.locked(`Too many wrong PIN attempts. Try again in ${minutesLeft(u.pinLockedUntil)} minutes.`, 'PIN_LOCKED');
  }
  if (await compareSecret(pin, u.pinHash)) {
    if (u.pinFailCount || u.pinLockedUntil) await User.updateOne({ _id: u._id }, { $set: { pinFailCount: 0 }, $unset: { pinLockedUntil: 1 } });
    return;
  }
  const after = await User.findOneAndUpdate({ _id: u._id }, { $inc: { pinFailCount: 1 } }, { new: true }).select('pinFailCount');
  if (after.pinFailCount >= PIN_MAX_FAILS) {
    await User.updateOne({ _id: u._id }, { $set: { pinFailCount: 0, pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS) } });
    throw E.locked('Too many wrong PIN attempts. Your PIN is locked for 30 minutes.', 'PIN_LOCKED');
  }
  const left = PIN_MAX_FAILS - after.pinFailCount;
  throw E.locked(`Incorrect PIN. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`, 'BAD_PIN', { attemptsLeft: left });
}

/** Verifies the transaction PIN, counting failures and locking after 5. Throws on any problem. */
const verifyPin = (userId, pin) => serialize(String(userId), () => verifyPinOnce(userId, pin));

/* --------------------------------------------------------------------- OTP */

/**
 * Creates and sends a 6-digit code. Rate limited per user: one per 30 s, five per hour.
 * Returns the code only so the caller can echo it when OTP_DEBUG is on in non-production.
 */
async function issueOtp(user, purpose) {
  const last = await Otp.findOne({ user: user._id, purpose }).sort({ createdAt: -1 }).lean();
  if (last) {
    const wait = OTP_COOLDOWN_S - Math.floor((Date.now() - new Date(last.createdAt).getTime()) / 1000);
    if (wait > 0) throw E.tooMany(`Please wait ${wait} seconds before asking for another code.`, 'OTP_COOLDOWN', { retryAfter: wait });
  }
  const recent = await Otp.countDocuments({ user: user._id, purpose, createdAt: { $gte: new Date(Date.now() - 3600 * 1000) } });
  if (recent >= OTP_PER_HOUR) throw E.tooMany('Too many codes requested. Please try again in an hour.', 'OTP_LIMIT');

  const code = otp.generateCode();
  const doc = await Otp.create({
    user: user._id,
    purpose,
    codeHash: otp.hashCode(purpose, String(user._id), code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  try {
    await providers.sms.send({
      to: user.phone,
      purpose,
      code,
      firstName: user.firstName,
      ttlMinutes: Math.round(OTP_TTL_MS / 60000),
      message: `Your TrustPay code is ${code}. It expires in 10 minutes. Never share it with anyone.`,
    });
  } catch (err) {
    await Otp.deleteOne({ _id: doc._id });
    log.error('SMS send failed', { purpose, message: err && err.message });
    throw E.unavailable('We could not send the code right now. Please try again shortly.', 'SMS_UNAVAILABLE');
  }
  return code;
}

/** Checks a code. Consumes it on success. Throws a readable error otherwise. */
async function checkOtp(user, purpose, code) {
  const doc = await Otp.findOne({ user: user._id, purpose, consumedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  if (!doc) throw E.validation('That code has expired. Please request a new one.', 'OTP_EXPIRED');
  if (doc.attempts >= doc.maxAttempts) throw E.validation('Too many wrong attempts. Please request a new code.', 'OTP_LOCKED');
  if (!otp.matches(purpose, String(user._id), code, doc.codeHash)) {
    await Otp.updateOne({ _id: doc._id }, { $inc: { attempts: 1 } });
    throw E.validation('That code is not correct.', 'OTP_INVALID');
  }
  const used = await Otp.findOneAndUpdate({ _id: doc._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
  if (!used) throw E.validation('That code was already used. Please request a new one.', 'OTP_USED');
}

module.exports = { signSession, signReset, verifyToken, verifyPin, issueOtp, checkOtp };
