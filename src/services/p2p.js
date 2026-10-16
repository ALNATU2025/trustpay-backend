'use strict';
/**
 * Wallet-to-wallet movement used by money requests and agent cash-in / cash-out.
 * The payer is debited atomically (amount + fee) through payDebit, the payee is credited exactly once.
 * `payeeExtraMinor` is the part of the fee the payee keeps (an agent's commission).
 */
const { Txn } = require('../models');
const { createWithReference } = require('../utils/references');
const { ProviderError } = require('../providers/errors');
const { payDebit, creditWallet, fullName, searchText } = require('./wallet');
const notify = require('./notify');
const { formatLe } = require('../utils/money');

async function moveMoney({ payer, payee, kind, code, outSubtype, inSubtype, amountMinor, feeMinor = 0, payeeExtraMinor = 0, outDetails = {}, inDetails = {}, notice }) {
  return payDebit({
    user: payer,
    kind,
    subtype: outSubtype,
    code,
    amountMinor,
    feeMinor,
    details: outDetails,
    perform: async (txn) => {
      let inbound;
      let credit;
      const credited = amountMinor + payeeExtraMinor;
      try {
        inbound = await createWithReference(Txn, code, (reference) => ({
          user: payee._id,
          reference,
          kind,
          subtype: inSubtype,
          direction: 'credit',
          amountMinor,
          feeMinor: 0,
          totalMinor: credited,
          status: 'Pending',
          details: { ...inDetails, ...(payeeExtraMinor ? { commissionMinor: payeeExtraMinor } : {}) },
          ownerName: fullName(payee),
          ownerAccount: payee.accountNumber,
          search: searchText([reference, fullName(payer), payer.accountNumber, inSubtype]),
          externalRef: `in:${txn._id}`,
        }));
        credit = await creditWallet(payee._id, credited, `in:${txn._id}`);
      } catch (err) {
        throw new ProviderError('We could not complete the payment.', { outcome: 'failed' });
      }
      // The payee HAS the money now: never report a failure from here (it would refund the payer too).
      await Txn.updateOne({ _id: inbound._id }, { $set: { status: 'Successful', balanceAfterMinor: credit.balanceMinor } }).catch(() => {});
      if (notice) {
        notify.notifyUser(payee._id, { type: 'funding', title: notice.title, body: notice.body(formatLe(credited)), data: { reference: inbound.reference } });
      }
      return { details: { inReference: inbound.reference } };
    },
  });
}

module.exports = { moveMoney };
