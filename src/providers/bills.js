'use strict';
/**
 * Bill vendor adapter (electricity, TV, internet).
 *   validateCustomer({ category, provider, number }) -> { customerName, address? } | null
 *   payBill({ category, provider, prepaid, number, amountMinor, reference, phone }) -> { providerRef, token?, units? }
 *   paySubscription({ category, provider, number, packageId, amountMinor, reference, phone }) -> { providerRef }
 *
 * SANDBOX: electricity meters must be exactly 11 digits; TV/internet account numbers 8-12 digits.
 * Prepaid electricity returns a deterministic-format 20-digit token (grouped in fours) and units
 * at a sandbox rate of Le 4.20 per kWh. Meters/accounts ending in 0000 are declined on payment.
 */
const crypto = require('crypto');
const { ProviderError, notConfigured } = require('./errors');
const select = require('./select');
const { randomHex } = require('../utils/crypto');

const SANDBOX_RATE_MINOR_PER_KWH = 420;

function validNumber(category, number) {
  return category === 'electricity' ? /^\d{11}$/.test(number) : /^\d{8,12}$/.test(number);
}

const sandbox = {
  async validateCustomer({ category, number }) {
    if (!validNumber(category, number)) return null;
    return {
      customerName: `Sandbox Customer ••${number.slice(-4)}`,
      address: category === 'electricity' ? 'Sandbox Street, Freetown' : undefined,
      sandbox: true,
    };
  },
  async payBill({ category, prepaid, number, amountMinor }) {
    if (!validNumber(category, number)) throw new ProviderError('Invalid meter or account number.', { outcome: 'failed' });
    if (number.endsWith('0000')) throw new ProviderError('The vendor declined the payment.', { outcome: 'failed' });
    const out = { providerRef: `sbx-bill-${randomHex(6)}`, sandbox: true };
    if (category === 'electricity' && prepaid) {
      let digits = '';
      while (digits.length < 20) digits += String(crypto.randomInt(0, 10));
      out.token = digits.match(/.{4}/g).join(' ');
      out.units = Math.round((amountMinor / SANDBOX_RATE_MINOR_PER_KWH) * 10) / 10;
    }
    return out;
  },
  async paySubscription({ category, number }) {
    if (!validNumber(category, number)) throw new ProviderError('Invalid account number.', { outcome: 'failed' });
    if (number.endsWith('0000')) throw new ProviderError('The provider declined the subscription.', { outcome: 'failed' });
    return { providerRef: `sbx-sub-${randomHex(6)}`, sandbox: true };
  },
};

// LIVE: needs a vendor agreement. Electricity = EDSA / a vending aggregator that issues STS
// tokens; TV = DStv/GOtv/StarTimes reseller APIs; internet = Orange/Africell/Sierratel reseller APIs.
const live = notConfigured('bills', 'EDSA (STS token vending) and TV/internet vendor reseller APIs', [
  'validateCustomer', 'payBill', 'paySubscription',
]);

module.exports = select({ sandbox, live });
