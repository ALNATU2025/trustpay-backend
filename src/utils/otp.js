'use strict';
const { randomDigits, hmacHex, safeEqual } = require('./crypto');

/** 6-digit numeric code from a CSPRNG. */
const generateCode = () => randomDigits(6);

/** OTPs are stored only as a keyed hash (HMAC) bound to purpose + subject. */
const hashCode = (purpose, subject, code) => hmacHex('otp', `${purpose}:${subject}:${code}`);

const matches = (purpose, subject, code, storedHash) => safeEqual(hashCode(purpose, subject, code), storedHash);

module.exports = { generateCode, hashCode, matches };
