'use strict';
const { randomDigits } = require('./crypto');
const { ddmmyy } = require('./time');

const CODES = {
  transfer: 'TRF',
  funding: 'ADD',
  bills: 'BIL',
  airtime: 'AIR',
  data: 'DAT',
  tv: 'TVB',
  internet: 'INT',
  card: 'CRD',
  pos: 'POS',
  mmSend: 'MMS',
  mmAdd: 'MMA',
  support: 'SUP',
  settlement: 'SET',
};

/** `TP-TRF-131026-4821` (code, DDMMYY, 4 random digits). */
const makeReference = (code, date = new Date()) => `TP-${code}-${ddmmyy(date)}-${randomDigits(4)}`;

const isDuplicateKey = (err, field) =>
  !!err && (err.code === 11000 || err.code === 11001) && (!field || (err.keyPattern && err.keyPattern[field]) || String(err.message).includes(field));

/**
 * Insert a document whose `reference` has a unique index, retrying with a fresh random
 * reference on collision. `build(reference)` returns the document fields.
 * `first` lets callers try a specific reference before falling back to random ones.
 */
async function createWithReference(Model, code, build, { retries = 12, first } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const reference = i === 0 && first ? first : makeReference(code);
    try {
      return await Model.create(build(reference));
    } catch (err) {
      if (isDuplicateKey(err, 'reference')) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('Could not allocate a unique reference');
}

module.exports = { CODES, makeReference, isDuplicateKey, createWithReference };
