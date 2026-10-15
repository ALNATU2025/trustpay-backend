'use strict';
/**
 * Card issuing adapter.
 *   issueVirtual({ holder })                    -> { pan, cvv, expiryMonth, expiryYear, providerRef }
 *   fundVirtual({ providerRef, amountMinor })   -> { providerRef }
 *   orderPhysical({ name, phone, address, city, state, reference }) -> { providerRef }
 *
 * SANDBOX: generates a Luhn-valid 16-digit PAN with the sandbox BIN 4000 00, 3-digit CVV,
 * expiry 3 years out. These cards are NOT real and cannot be used anywhere.
 */
const crypto = require('crypto');
const { notConfigured } = require('./errors');
const select = require('./select');
const { generatePan } = require('../utils/luhn');
const { randomHex } = require('../utils/crypto');

const sandbox = {
  async issueVirtual() {
    const now = new Date();
    return {
      pan: generatePan('400000', 16),
      cvv: String(crypto.randomInt(0, 1000)).padStart(3, '0'),
      expiryMonth: now.getUTCMonth() + 1,
      expiryYear: now.getUTCFullYear() + 3,
      providerRef: `sbx-card-${randomHex(6)}`,
      sandbox: true,
    };
  },
  async fundVirtual() {
    return { providerRef: `sbx-cardfund-${randomHex(6)}`, sandbox: true };
  },
  async orderPhysical() {
    return { providerRef: `sbx-pcard-${randomHex(6)}`, sandbox: true };
  },
};

// LIVE: needs a card-issuing partner / BIN sponsor (a licensed bank or issuer-processor) with
// PCI-compliant APIs. Do not generate real PANs yourself.
const live = notConfigured('cardIssuer', 'a card issuing / BIN sponsor partner', ['issueVirtual', 'fundVirtual', 'orderPhysical']);

module.exports = select({ sandbox, live });
