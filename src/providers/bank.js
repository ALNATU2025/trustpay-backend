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

// LIVE: connect to your bank-transfer partner. In Sierra Leone this means an agreement with a
// commercial bank or switch that exposes name-enquiry and funds-transfer APIs (e.g. via the
// Bank of Sierra Leone's RTGS/ACH access or a partner bank's corporate API).
const live = notConfigured('bank', 'a Sierra Leone bank / switch name-enquiry + transfer API', ['nameEnquiry', 'transfer']);

module.exports = select({ sandbox, live });
