'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../config/env');

/** Sub-key derived from JWT_SECRET so we do not reuse one key for several purposes. */
const derive = (label) => crypto.createHmac('sha256', env.jwtSecret).update(`trustpay:${label}`).digest();

const hmacHex = (label, data) => crypto.createHmac('sha256', derive(label)).update(String(data)).digest('hex');

/** Timing-safe comparison of two hex (or any) strings of arbitrary length. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // keep timing roughly constant
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/** Verify an HMAC-SHA256 hex signature of the raw request body. */
function verifyHmac(rawBody, signature, secret) {
  if (!rawBody || typeof signature !== 'string') return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = signature.trim().replace(/^sha256=/i, '').toLowerCase();
  return safeEqual(expected, given);
}

const hashSecret = (plain) => bcrypt.hash(String(plain), env.bcryptCost);
const compareSecret = (plain, hash) => bcrypt.compare(String(plain), hash);

// A valid bcrypt hash used to equalise timing when the account does not exist.
let dummyHash;
async function dummyCompare(plain) {
  if (!dummyHash) dummyHash = await bcrypt.hash('trustpay-dummy', env.bcryptCost);
  await bcrypt.compare(String(plain), dummyHash);
}

/* ---- AES-256-GCM for card PAN / CVV ---- */
const cardKey = () => Buffer.from(env.cardKeyHex, 'hex');

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cardKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

function decrypt(payload) {
  const [v, iv, tag, ct] = String(payload).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Bad ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', cardKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

const randomDigits = (n) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = {
  derive, hmacHex, safeEqual, verifyHmac, hashSecret, compareSecret, dummyCompare,
  encrypt, decrypt, randomDigits, randomHex, sha256,
};
