'use strict';
/**
 * Bank rail adapter.
 *   nameEnquiry({ bank, accountNumber })  -> { accountName } | null
 *   transfer({ bank, accountNumber, accountName, amountMinor, reference, narration }) -> { providerRef }
 *
 * SANDBOX behaviour (deterministic):
 *  - nameEnquiry: account must be 6-20 digits. If the number belongs to a TrustPay user, that
 *    user's full name is returned; otherwise `Sandbox Account ••<last4>`.
 *  - transfer: always succeeds, EXCEPT account numbers ending in 0000 which fail ("declined"),
 *    and numbers ending in 9999 which return an unknown outcome (stays Pending). Use these to test
 *    refund and pending handling.
 */
const { ProviderError, notConfigured } = require('./errors');
const select = require('./select');
const { randomHex } = require('../utils/crypto');

const sandbox = {
  async nameEnquiry({ accountNumber }) {
    if (!/^\d{6,20}$/.test(accountNumber)) return null;
    const User = require('../models/User');
    const u = await User.findOne({ accountNumber }).select('firstName lastName status').lean();
    if (u && u.status !== 'suspended') return { accountName: `${u.firstName} ${u.lastName}`.trim(), sandbox: true };
    return { accountName: `Sandbox Account ••${accountNumber.slice(-4)}`, sandbox: true };
  },
  async transfer({ accountNumber }) {
    if (accountNumber.endsWith('0000')) throw new ProviderError('The receiving bank declined the transfer.', { outcome: 'failed' });
    if (accountNumber.endsWith('9999')) throw new ProviderError('The receiving bank did not respond.', { outcome: 'unknown' });
    return { providerRef: `sbx-bank-${randomHex(6)}`, sandbox: true };
  },
};

// LIVE: Monime (https://docs.monime.io). Name check = Provider KYC, transfer = Payout to a bank account.
const directory = require('./monime/directory');
const kyc = require('./monime/kyc');
const payouts = require('./monime/payouts');

const live = {
  async nameEnquiry({ bank, accountNumber }) {
    if (!/^\d{6,20}$/.test(accountNumber)) return null;
    const provider = await directory.resolve('bank', bank);
    const name = await kyc.holderName(provider.providerId, accountNumber);
    if (name === null) return null;
    // undefined = this bank does not offer name checks: let the customer confirm the number themselves.
    return { accountName: name || `Account ••${accountNumber.slice(-4)}`, unverified: name === undefined };
  },
  async transfer({ bank, accountNumber, amountMinor, reference }) {
    const provider = await directory.resolve('bank', bank);
    return payouts.send({
      amountMinor,
      reference,
      destination: { type: 'bank', providerId: provider.providerId, accountNumber },
    });
  },
};

module.exports = select({ sandbox, live });
