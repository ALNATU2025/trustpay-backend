'use strict';
/**
 * Payouts (money leaving TrustPay to a bank account or a mobile-money wallet).
 * POST /v1/payouts is asynchronous: the payout is `pending`/`processing` first, then `completed` or
 * `failed`. We wait a few seconds for a quick answer; if it is still running we return an
 * "unknown" ProviderError that carries the payout id, so the transaction stays Pending and the
 * webhook (or `npm run reconcile`) finishes it later.
 */
const env = require('../../config/env');
const client = require('./client');
const { ProviderError } = require('../errors');

const FAIL_TEXT = {
  fund_insufficient: 'We could not complete this payment right now. Please try again later.',
  authorization_failed: 'The payment was not authorised.',
  provider_account_blocked: 'The receiving account cannot accept payments.',
  provider_account_missing: 'The receiving account was not found.',
  provider_account_quota_exhausted: 'The receiving account has reached its limit.',
  provider_unknown: 'The receiving provider could not complete the payment.',
  unknown: 'The payment could not be completed.',
};

const failText = (payout) => FAIL_TEXT[(payout.failureDetail && payout.failureDetail.code) || 'unknown'] || FAIL_TEXT.unknown;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** destination: { type:'bank', providerId, accountNumber } | { type:'momo', providerId, phoneNumber } */
async function send({ amountMinor, destination, reference }) {
  const body = {
    amount: { currency: 'SLE', value: amountMinor },
    destination,
    metadata: { trustpayReference: String(reference) },
  };
  if (env.monime.payoutAccountId) body.source = { financialAccountId: env.monime.payoutAccountId };
  const payout = await client.write('POST', '/v1/payouts', body, `tp-${reference}`);
  return settleQuickly(payout);
}

async function settleQuickly(payout) {
  let cur = payout;
  for (let i = 0; i < 4 && cur && !isFinal(cur); i++) {
    await sleep(1500);
    try {
      cur = await client.read(`/v1/payouts/${encodeURIComponent(payout.id)}`);
    } catch (_) {
      break; // a read failure here does not change the payout: the webhook/reconcile will finish it
    }
  }
  if (cur && cur.status === 'completed') return { providerRef: cur.id };
  if (cur && cur.status === 'failed') throw new ProviderError(failText(cur), { outcome: 'failed' });
  const err = new ProviderError('The payment is being processed.', { outcome: 'unknown' });
  err.providerRef = payout.id;
  throw err;
}

const isFinal = (p) => p.status === 'completed' || p.status === 'failed';

const get = (id) => client.read(`/v1/payouts/${encodeURIComponent(id)}`);

module.exports = { send, get, failText, isFinal };
