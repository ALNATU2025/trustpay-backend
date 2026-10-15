'use strict';
/**
 * Money helpers. All balances/amounts are INTEGER minor units (Le x 100) in MongoDB.
 * Conversion to/from decimal Leones happens only at the API edge (validators in, presenters out).
 */
const env = require('../config/env');
const { E } = require('./errors');

const SCALE = 100;

/** Le (decimal number) -> minor units; used for code constants, e.g. le(1.5) === 150. */
const le = (n) => Math.round(n * SCALE);

/**
 * Parse an API amount into integer minor units.
 * Rejects non-finite, negative, zero (unless allowZero), more than 2 decimals, and over the max.
 * Tiny float noise (0.1 + 0.2) is tolerated and rounded half up.
 */
function toMinor(value, { allowZero = false, max = env.maxAmountMinor, label = 'Amount' } = {}) {
  if (value === undefined || value === null || value === '') throw E.validation(`${label} is required.`);
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)) n = Number(value);
  else throw E.validation(`${label} must be a number.`);
  if (!Number.isFinite(n)) throw E.validation(`${label} must be a valid number.`);
  if (n < 0) throw E.validation(`${label} must be greater than zero.`);
  const scaled = n * SCALE;
  const minor = Math.round(scaled); // half up (n >= 0)
  if (Math.abs(scaled - minor) > 1e-6) throw E.validation(`${label} can have at most 2 decimal places.`);
  if (!allowZero && minor <= 0) throw E.validation(`${label} must be greater than zero.`);
  if (minor > max) throw E.validation(`${label} is above the maximum of ${formatLe(max)}.`);
  if (!Number.isSafeInteger(minor)) throw E.validation(`${label} is too large.`);
  return minor;
}

/** Integer minor units -> decimal Leones number for JSON. */
const fromMinor = (minor) => Math.round(Number(minor) || 0) / SCALE;

/** minor * bps / 10000 rounded half up (integer math only). */
const bpsOf = (minor, bps) => Math.floor((minor * bps + 5000) / 10000);

/** "Le 1,500" or "Le 1,500.50" (compact), or always 2 decimals with `fixed`. */
function formatLe(minor, { fixed = false } = {}) {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / SCALE);
  const frac = abs % SCALE;
  const w = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const f = fixed || frac !== 0 ? `.${String(frac).padStart(2, '0')}` : '';
  return `${neg ? '-' : ''}Le ${w}${f}`;
}

module.exports = { SCALE, le, toMinor, fromMinor, bpsOf, formatLe };
