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

// LIVE: Monime. Name check = Provider KYC, send = Payout to a wallet. Money IN from a wallet is done through
// hosted checkout (see providers/checkout.js and POST /payments/funding/checkout), not an approval code.
const directory = require('./monime/directory');
const kyc = require('./monime/kyc');
const payouts = require('./monime/payouts');

const msisdn = (number) => `232${number}`; // stored as 8 national digits

const live = {
  async nameEnquiry({ provider, number }) {
    if (!/^\d{8}$/.test(number)) return null;
    const p = await directory.resolve('momo', provider);
    const name = await kyc.holderName(p.providerId, msisdn(number));
    if (name === null) return null;
    return { holderName: name || `Wallet ••${number.slice(-4)}`, unverified: name === undefined };
  },
  async send({ provider, number, amountMinor, reference }) {
    const p = await directory.resolve('momo', provider);
    return payouts.send({
      amountMinor,
      reference,
      destination: { type: 'momo', providerId: p.providerId, phoneNumber: msisdn(number) },
    });
  },
  async collect() {
    throw new ProviderError('Use "Add money online" to fund your wallet from mobile money.', { outcome: 'failed' });
  },
};

module.exports = select({ sandbox, live });
