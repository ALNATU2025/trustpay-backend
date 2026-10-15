'use strict';
const log = require('../utils/log');
const { Idempotency } = require('../models');
const { E, AppError } = require('../utils/errors');
const { hmacHex } = require('../utils/crypto');
const { isDuplicateKey } = require('../utils/references');

const KEY_RE = /^[A-Za-z0-9._:-]{8,80}$/;

/**
 * Runs `fn` (returning `{ status, body }`) at most once per (user, Idempotency-Key).
 * A repeat with the same key and body replays the stored response; the same key with a different
 * body is rejected. Requests without the header just run. The body hash is keyed (HMAC) so a
 * leaked database cannot be used to brute-force a PIN out of it.
 */
async function idempotent(req, route, fn) {
  const key = req.get('Idempotency-Key');
  if (!key) return fn();
  if (!KEY_RE.test(key)) throw E.validation('Idempotency-Key must be 8-80 letters, numbers or . _ : -');

  const user = req.user._id;
  const requestHash = hmacHex('idem', `${route}:${JSON.stringify(req.body)}`);

  try {
    log.info('idempotency: reserving key', { route });
    await Idempotency.create({ user, key, route, requestHash });
    log.info('idempotency: reserved', { route });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const doc = await Idempotency.findOne({ user, key }).lean();
    if (!doc) throw E.conflict('Please try again.', 'RETRY');
    if (doc.route !== route || doc.requestHash !== requestHash) {
      throw E.conflict('That Idempotency-Key was already used for a different request.', 'IDEMPOTENCY_KEY_REUSED');
    }
    if (doc.state === 'done') return { status: doc.statusCode, body: doc.response, replay: true };
    throw E.conflict('This payment is already being processed.', 'IN_PROGRESS');
  }

  try {
    const out = await fn();
    await Idempotency.updateOne({ user, key }, { $set: { state: 'done', statusCode: out.status, response: out.body } });
    return out;
  } catch (err) {
    // Expected failures (validation, wrong PIN, insufficient funds, partner refused and refunded) leave
    // nothing half done, so the same key may be retried. An unexpected error could have happened after
    // the customer was charged: keep the key so a retry cannot charge twice (it answers IN_PROGRESS).
    if (err instanceof AppError) await Idempotency.deleteOne({ user, key }).catch(() => {});
    throw err;
  }
}

module.exports = { idempotent };
