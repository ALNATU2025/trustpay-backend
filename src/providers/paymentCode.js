'use strict';
/**
 * Mobile money top-up with a Monime Payment Code (USSD).
 * The customer gets a short code, dials the USSD string on their own phone and approves the payment
 * from their wallet. Money lands in the Monime space's financial account (`MONIME_FUNDING_ACCOUNT_ID`,
 * or the space's main account when it is not set) and the wallet is credited when Monime confirms.
 *   create({ provider, number, amountMinor, reference, name }) -> { id, ussdCode, expiresAt, instant }
 *   status(id)                                                  -> { paid, expired }
 *
 * SANDBOX: no real code; the wallet is credited at once (`instant: true`). Numbers ending in 0000 are declined.
 */
const env = require('../config/env');
const select = require('./select');
const { randomHex } = require('../utils/crypto');
const { ProviderError } = require('./errors');
const directory = require('./monime/directory');

const DURATION = '15m';

const sandbox = {
  async create({ number }) {
    if (number.endsWith('0000')) throw new ProviderError('The wallet provider declined the payment.', { outcome: 'failed' });
    return { id: `sbx-pc-${randomHex(6)}`, ussdCode: null, expiresAt: null, instant: true, sandbox: true };
  },
  async status() {
    return { paid: true, expired: false };
  },
};

const client = () => require('./monime/client');

const live = {
  async create({ provider, number, amountMinor, reference, name }) {
    const p = await directory.resolve('momo', provider);
    const body = {
      name: (name || 'TrustPay top-up').slice(0, 64),
      mode: 'one_time',
      enable: true,
      amount: { currency: 'SLE', value: amountMinor },
      duration: DURATION,
      customer: name ? { name: String(name).slice(0, 64) } : undefined,
      reference: String(reference).slice(0, 64),
      authorizedProviders: [p.providerId],
      authorizedPhoneNumber: `232${number}`,
      metadata: { trustpayReference: reference },
    };
    if (env.monime.fundingAccountId) body.financialAccountId = env.monime.fundingAccountId;
    const code = await client().write('POST', '/v1/payment-codes', body, `tp-${reference}`);
    if (!code || !code.id || !code.ussdCode) throw new ProviderError('The payment code could not be created.', { outcome: 'failed' });
    return { id: code.id, ussdCode: code.ussdCode, expiresAt: code.expireTime || null, instant: false };
  },
  async status(id) {
    const c = await client().read(`/v1/payment-codes/${encodeURIComponent(id)}`);
    return { paid: !!c && c.status === 'completed', expired: !!c && (c.status === 'expired' || c.status === 'cancelled') };
  },
};

module.exports = select({ sandbox, live });
