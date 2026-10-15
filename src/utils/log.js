'use strict';
/**
 * Tiny logger. Callers must never pass secrets, PINs, OTPs, passwords, tokens or card numbers.
 * Messages are single-line JSON-ish for easy reading in the Render log stream.
 */
const env = require('../config/env');

function line(level, msg, meta) {
  if (env.isTest && level !== 'error') return;
  const out = { t: new Date().toISOString(), level, msg };
  if (meta !== undefined) out.meta = meta;
  const text = JSON.stringify(out);
  (level === 'error' ? console.error : console.log)(text);
}

module.exports = {
  info: (m, meta) => line('info', m, meta),
  warn: (m, meta) => line('warn', m, meta),
  error: (m, meta) => line('error', m, meta),
};
