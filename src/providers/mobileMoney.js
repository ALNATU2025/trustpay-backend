'use strict';
/**
 * Mobile money adapter (Orange Money, Afrimoney, Qmoney).
 *   nameEnquiry({ provider, number })                        -> { holderName } | null   (number = stored 8 digits)
 *   send({ provider, number, amountMinor, reference })        -> { providerRef }          (payout to wallet)
 *   collect({ provider, number, amountMinor, code, reference }) -> { providerRef }        (pull from wallet using approval code)
 *
 * SANDBOX: holder name is the TrustPay user's name if the phone is registered, otherwise
 * `Sandbox Wallet ••<last4>`. collect() approves any 6-digit code except 000000 (declined).
 * send(): numbers ending in 0000 are declined.
 */
const { ProviderError, notConfigured } = require('./errors');
const select = require('./select');
const { randomHex } = require('../utils/crypto');

const sandbox = {
  async nameEnquiry({ number }) {
    if (!/^\d{8}$/.test(number)) return null;
    const User = require('../models/User');
    const u = await User.findOne({ phone: number }).select('firstName lastName').lean();
    if (u) return { holderName: `${u.firstName} ${u.lastName}`.trim(), sandbox: true };
    return { holderName: `Sandbox Wallet ••${number.slice(-4)}`, sandbox: true };
  },
  async send({ number }) {
    if (number.endsWith('0000')) throw new ProviderError('The wallet provider declined the transfer.', { outcome: 'failed' });
    return { providerRef: `sbx-momo-${randomHex(6)}`, sandbox: true };
  },
  async collect({ code }) {
    if (!/^\d{6}$/.test(code) || code === '000000') throw new ProviderError('The approval code was not accepted.', { outcome: 'failed' });
    return { providerRef: `sbx-momo-in-${randomHex(6)}`, sandbox: true };
  },
};

// LIVE: needs merchant/disbursement agreements with Orange Money SL, Africell (Afrimoney) and
// Qcell (Qmoney) - each exposes its own collection (request-to-pay) and disbursement API.
const live = notConfigured('mobileMoney', 'Orange Money / Afrimoney / Qmoney merchant APIs', ['nameEnquiry', 'send', 'collect']);

module.exports = select({ sandbox, live });
