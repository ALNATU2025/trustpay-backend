'use strict';
/**
 * Hosted checkout for card top-ups: the customer pays on Monime's page with a card.
 * (Mobile money top-ups use a USSD payment code, see providers/paymentCode.js.) TrustPay never sees card numbers.
 *   create({ amountMinor, reference, name }) -> { id, url, instant }
 *   status(id)                              -> { paid: boolean, expired: boolean }
 *
 * SANDBOX: no page; the top-up is credited immediately (`instant: true`).
 */
const env = require('../config/env');
const select = require('./select');
const { randomHex } = require('../utils/crypto');
const { ProviderError } = require('./errors');

const sandbox = {
  async create() {
    return { id: `sbx-chk-${randomHex(6)}`, url: null, instant: true, sandbox: true };
  },
  async status() {
    return { paid: true, expired: false };
  },
};

const client = () => require('./monime/client');

const live = {
  async create({ amountMinor, reference, name }) {
    const base = env.publicUrl;
    if (!base) throw new ProviderError('Checkout is not configured (PUBLIC_URL).', { outcome: 'failed', code: 'PROVIDER_NOT_CONFIGURED' });
    const session = await client().write(
      'POST',
      '/v1/checkout-sessions',
      {
        name: name || 'TrustPay top-up',
        description: `Add money to your TrustPay wallet (${reference})`,
        reference,
        successUrl: `${base}/api/pay/return?status=success&ref=${encodeURIComponent(reference)}`,
        cancelUrl: `${base}/api/pay/return?status=cancelled&ref=${encodeURIComponent(reference)}`,
        lineItems: [{ type: 'custom', name: 'Wallet top-up', price: { currency: 'SLE', value: amountMinor }, quantity: 1, reference: 'topup' }],
        paymentOptions: { card: { disable: false }, bank: { disable: true }, momo: { disable: true }, wallet: { disable: true } },
        metadata: { trustpayReference: reference },
      },
      `tp-${reference}`,
    );
    if (!session || !session.id || !session.redirectUrl) {
      throw new ProviderError('The payment page could not be created.', { outcome: 'failed' });
    }
    return { id: session.id, url: session.redirectUrl, instant: false };
  },
  async status(id) {
    const s = await client().read(`/v1/checkout-sessions/${encodeURIComponent(id)}`);
    return { paid: !!s && s.status === 'completed', expired: !!s && (s.status === 'expired' || s.status === 'cancelled') };
  },
};

module.exports = select({ sandbox, live });
