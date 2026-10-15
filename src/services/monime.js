'use strict';
/**
 * Turns Monime events into wallet changes.
 *
 * SECURITY: an event body is only a HINT ("something happened to payout X"). We never credit or
 * refund from the body. We always re-read the payout / checkout session / payment from the Monime
 * API with our own token and act on that. A forged webhook therefore cannot move money.
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');
const { Txn } = require('../models');
const payouts = require('../providers/monime/payouts');
const client = require('../providers/monime/client');
const { settleDebit, settleCredit, failCredit } = require('./wallet');
const { safeEqual } = require('../utils/crypto');
const log = require('../utils/log');

const SIGNATURE_HEADERS = ['monime-signature', 'x-monime-signature', 'x-signature', 'webhook-signature', 'x-webhook-signature'];

/**
 * Optional integrity check for the HS256 secret you registered with Monime.
 * Monime's public docs do not name the signature header, so we accept the common shapes:
 * a raw HMAC-SHA256 of the body (hex or base64, optional "sha256="/"v1=" prefix) or an HS256 JWT.
 * Returns 'ok' | 'bad' | 'none' (no recognisable signature header, or no secret configured).
 */
function checkSignature(req) {
  const secret = env.monime.webhookSecret;
  if (!secret) return 'none';
  let value;
  for (const h of SIGNATURE_HEADERS) {
    if (req.get(h)) {
      value = req.get(h).trim();
      break;
    }
  }
  if (!value) return 'none';
  const raw = req.rawBody || Buffer.from('');
  const mac = crypto.createHmac('sha256', secret).update(raw).digest();
  const candidates = [mac.toString('hex'), mac.toString('base64'), mac.toString('base64url')];
  const stripped = value.replace(/^(sha256=|v1=)/i, '');
  if (candidates.some((c) => safeEqual(c, stripped))) return 'ok';
  if (value.split('.').length === 3) {
    try {
      jwt.verify(value.replace(/^Bearer\s+/i, ''), secret, { algorithms: ['HS256'], ignoreExpiration: false });
      return 'ok';
    } catch (_) {
      return 'bad';
    }
  }
  return 'bad';
}

async function handlePayout(id) {
  const payout = await payouts.get(id);
  let txn = await Txn.findOne({ providerRef: id, direction: 'debit' });
  if (!txn && payout.metadata && payout.metadata.trustpayReference) {
    txn = await Txn.findOne({ reference: payout.metadata.trustpayReference, direction: 'debit' });
  }
  if (!txn) return { handled: false };
  if (payout.status === 'completed') return { handled: true, ...(await settleDebit(txn._id, 'success')) };
  if (payout.status === 'failed') return { handled: true, ...(await settleDebit(txn._id, 'failed', payouts.failText(payout))) };
  return { handled: true, changed: false };
}

async function handleSession(id) {
  const txn = await Txn.findOne({ providerRef: id, subtype: 'funding_checkout' });
  if (!txn) return { handled: false };
  const session = await client.read(`/v1/checkout-sessions/${encodeURIComponent(id)}`);
  if (session.status === 'completed') return { handled: true, ...(await settleCredit(txn._id)) };
  if (session.status === 'cancelled' || session.status === 'expired') {
    return { handled: true, ...(await failCredit(txn._id, session.status === 'expired' ? 'The payment page expired.' : 'The payment was cancelled.')) };
  }
  return { handled: true, changed: false };
}

async function handleCode(id) {
  const txn = await Txn.findOne({ providerRef: id, subtype: 'funding_momo_code' });
  if (!txn) return { handled: false };
  const code = await client.read(`/v1/payment-codes/${encodeURIComponent(id)}`);
  const state = String(code.status || '').toLowerCase();
  if (!['pending', 'processing', 'completed', 'expired', 'cancelled'].includes(state)) log.warn('Payment code has an unfamiliar status', { status: code.status });
  if (['completed', 'fulfilled', 'paid', 'successful'].includes(state)) return { handled: true, ...(await settleCredit(txn._id)) };
  if (state === 'expired' || state === 'cancelled') {
    return { handled: true, ...(await failCredit(txn._id, 'The payment code expired before it was used.')) };
  }
  return { handled: true, changed: false };
}

async function handlePayment(id) {
  const payment = await client.read(`/v1/payments/${encodeURIComponent(id)}`);
  if (payment.status !== 'completed') return { handled: true, changed: false };
  const owner = payment.ownershipGraph && payment.ownershipGraph.owner;
  if (!owner || !['checkout_session', 'payment_code'].includes(owner.type)) return { handled: false };
  const txn = await Txn.findOne({ providerRef: owner.id, subtype: owner.type === 'payment_code' ? 'funding_momo_code' : 'funding_checkout' });
  if (!txn) return { handled: false };
  const paid = payment.amount;
  if (!paid || paid.currency !== 'SLE' || paid.value < txn.amountMinor) {
    log.error('Checkout payment smaller than expected: not credited', { reference: txn.reference, paid });
    await Txn.updateOne({ _id: txn._id }, { $set: { needsReview: true } });
    return { handled: true, changed: false };
  }
  return { handled: true, ...(await settleCredit(txn._id)) };
}

/** Entry point for POST /api/webhooks/monime. */
async function processEvent(body) {
  const name = body && body.event && body.event.name;
  const objId = (body && body.object && body.object.id) || (body && body.data && body.data.id);
  if (!name || !objId || typeof objId !== 'string') return { handled: false };
  if (name.startsWith('payout.')) return handlePayout(objId);
  if (name.startsWith('checkout_session.')) return handleSession(objId);
  if (name.startsWith('payment_code.')) return handleCode(objId);
  if (name.startsWith('payment.')) return handlePayment(objId);
  return { handled: false };
}

/**
 * Safety net for missed webhooks (npm run reconcile / cron). Looks at everything still Pending
 * for more than `minAgeMs` and asks Monime for the real state.
 */
async function reconcilePending({ minAgeMs = 60 * 1000, limit = 200 } = {}) {
  const before = new Date(Date.now() - minAgeMs);
  const pending = await Txn.find({ status: 'Pending', providerRef: { $exists: true, $ne: null }, createdAt: { $lt: before } })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
  const out = { checked: 0, settled: 0, errors: 0 };
  for (const t of pending) {
    out.checked += 1;
    try {
      let r = { changed: false };
      if (t.subtype === 'funding_checkout') r = await handleSession(t.providerRef);
      else if (t.subtype === 'funding_momo_code') r = await handleCode(t.providerRef);
      else if (t.direction === 'debit') r = await handlePayout(t.providerRef);
      if (r.changed) out.settled += 1;
    } catch (err) {
      out.errors += 1;
      log.warn('Reconcile skipped a transaction', { reference: t.reference, message: err && err.message });
    }
  }
  return out;
}

const lastLook = new Map();

/**
 * Called while the app polls a Pending top-up: asks Monime for the real state (at most every 3 s per
 * transaction) so the wallet is credited even if the webhook is late or not registered.
 */
async function refreshPending(txn) {
  if (!txn || txn.status !== 'Pending' || !txn.providerRef || env.providerMode !== 'live') return { changed: false };
  const now = Date.now();
  if (now - (lastLook.get(String(txn._id)) || 0) < 3000) return { changed: false };
  lastLook.set(String(txn._id), now);
  if (lastLook.size > 5000) lastLook.clear();
  try {
    if (txn.subtype === 'funding_momo_code') return await handleCode(txn.providerRef);
    if (txn.subtype === 'funding_checkout') return await handleSession(txn.providerRef);
  } catch (err) {
    log.warn('Pending check failed', { reference: txn.reference, message: err && err.message });
  }
  return { changed: false };
}

module.exports = { checkSignature, processEvent, reconcilePending, refreshPending };
