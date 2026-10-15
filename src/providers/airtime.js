'use strict';
/**
 * Airtime / data adapter.
 *   topup({ network, phone, amountMinor, reference })       -> { providerRef }
 *   dataBundle({ network, phone, plan, reference })           -> { providerRef }   (plan = catalog data plan)
 * `phone` is the stored 8-digit number.
 * SANDBOX: always succeeds, except numbers ending in 0000 (declined).
 */
const { ProviderError, notConfigured } = require('./errors');
const select = require('./select');
const { randomHex } = require('../utils/crypto');

const sandbox = {
  async topup({ phone }) {
    if (phone.endsWith('0000')) throw new ProviderError('The network declined the top-up.', { outcome: 'failed' });
    return { providerRef: `sbx-air-${randomHex(6)}`, sandbox: true };
  },
  async dataBundle({ phone }) {
    if (phone.endsWith('0000')) throw new ProviderError('The network declined the data purchase.', { outcome: 'failed' });
    return { providerRef: `sbx-dat-${randomHex(6)}`, sandbox: true };
  },
};

// LIVE: bulk airtime/data reseller APIs from Orange SL, Africell and Qcell (or an aggregator).
const live = notConfigured('airtime', 'Orange / Africell / Qcell airtime and data reseller APIs', ['topup', 'dataBundle']);

module.exports = select({ sandbox, live });
