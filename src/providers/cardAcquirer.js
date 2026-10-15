'use strict';
/**
 * Card acquiring adapter, for "fund my wallet from a debit card".
 *   charge({ amountMinor, feeMinor, cardLast4, brand, reference }) -> { providerRef }
 *
 * The app never sends a PAN. In production the card is captured by the provider's hosted
 * checkout / SDK and the credit arrives via webhook; the live adapter is where that is wired.
 * SANDBOX: charges succeed immediately (cards ending in 0000 are declined).
 */
const { ProviderError, notConfigured } = require('./errors');
const select = require('./select');
const { randomHex } = require('../utils/crypto');

const sandbox = {
  async charge({ cardLast4 }) {
    if (cardLast4 === '0000') throw new ProviderError('The card was declined.', { outcome: 'failed' });
    return { providerRef: `sbx-acq-${randomHex(6)}`, sandbox: true };
  },
};

// LIVE: raw card details are never accepted by this API. Card (and bank / mobile money) top-ups go through
// Monime's hosted checkout page: POST /payments/funding/checkout.
const live = {
  async charge() {
    throw new ProviderError('Use "Add money online" to fund your wallet from a card.', { outcome: 'failed' });
  },
};

module.exports = select({ sandbox, live });
