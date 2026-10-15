'use strict';
/**
 * The money engine. Rules that every payment follows:
 *  1. A Txn row is written FIRST (Pending), so money never moves without a record.
 *  2. The wallet debit is ONE atomic conditional update (`balanceMinor >= total`), so concurrent
 *     requests can never overdraw an account.
 *  3. Credits carry a unique key stored on the user (`appliedCredits`), so a retry or a duplicated
 *     webhook can never credit twice.
 *  4. If the partner clearly failed, the debit is refunded and a reversal row is written.
 *     If the outcome is unknown (timeout), the Txn stays Pending with needsReview=true and is NOT
 *     refunded automatically; reconcile with the partner (see `npm run check`).
 */
const { User, Txn } = require('../models');
const { E } = require('../utils/errors');
const { createWithReference, isDuplicateKey, CODES } = require('../utils/references');
const { ProviderError, NotConfiguredError } = require('../providers/errors');
const log = require('../utils/log');
const { present } = require('./presenter');

const APPLIED_KEEP = 200;

const fullName = (u) => `${u.firstName} ${u.lastName}`.trim();

function searchText(fields) {
  return fields
    .flat()
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v).toLowerCase())
    .join(' ')
    .slice(0, 400);
}

/** Throws unless the user may move money. */
function assertCanTransact(user) {
  if (user.status === 'suspended') throw E.forbidden('Your account is suspended. Please contact support.', 'SUSPENDED');
  if (user.onboardingStep !== 'done' || !user.hasPin) {
    throw E.forbidden('Finish setting up your account before making payments.', 'ONBOARDING_INCOMPLETE');
  }
  if (user.status !== 'active') throw E.forbidden('Your account is not active yet.', 'ACCOUNT_NOT_ACTIVE');
}

/** Atomic debit. Returns the updated user (balance only) or null when the balance is too low. */
const debitWallet = (userId, totalMinor) =>
  User.findOneAndUpdate(
    { _id: userId, balanceMinor: { $gte: totalMinor } },
    { $inc: { balanceMinor: -totalMinor } },
    { new: true },
  ).select('balanceMinor');

/** Idempotent credit. `applied=false` means this key was already applied. */
async function creditWallet(userId, minor, key) {
  const updated = await User.findOneAndUpdate(
    { _id: userId, appliedCredits: { $ne: key } },
    { $inc: { balanceMinor: minor }, $push: { appliedCredits: { $each: [key], $slice: -APPLIED_KEEP } } },
    { new: true },
  ).select('balanceMinor');
  if (updated) return { applied: true, balanceMinor: updated.balanceMinor };
  const current = await User.findById(userId).select('balanceMinor');
  if (!current) throw E.notFound('Account not found.');
  return { applied: false, balanceMinor: current.balanceMinor };
}

async function reverse(txn, balanceMinor, reason) {
  try {
    await createWithReference(Txn, CODES.transfer, (reference) => ({
      user: txn.user,
      reference,
      kind: txn.kind,
      subtype: 'reversal',
      direction: 'credit',
      amountMinor: txn.totalMinor,
      feeMinor: 0,
      totalMinor: txn.totalMinor,
      status: 'Successful',
      details: { originalReference: txn.reference, originalTitle: present(txn).title, reason },
      ownerName: txn.ownerName,
      ownerAccount: txn.ownerAccount,
      search: searchText([reference, 'refund reversal', txn.reference]),
      balanceAfterMinor: balanceMinor,
      externalRef: `reversal:${txn._id}`,
      isReversal: true,
      reversalOf: txn._id,
    }));
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
}

/**
 * Debit-side payment.
 *   perform(txn) talks to the partner and returns { providerRef?, token?, details? }.
 *   It must throw ProviderError({outcome:'failed'}) when nothing happened on the rail.
 * Returns { txn (lean), balanceMinor }.
 */
async function payDebit({ user, kind, subtype, code, amountMinor, feeMinor = 0, details = {}, perform }) {
  assertCanTransact(user);
  const totalMinor = amountMinor + feeMinor;

  const txn = await createWithReference(Txn, code, (reference) => ({
    user: user._id,
    reference,
    kind,
    subtype,
    direction: 'debit',
    amountMinor,
    feeMinor,
    totalMinor,
    status: 'Pending',
    details,
    ownerName: fullName(user),
    ownerAccount: user.accountNumber,
    search: searchText([reference, subtype, Object.values(details)]),
  }));

  const after = await debitWallet(user._id, totalMinor);
  if (!after) {
    await Txn.deleteOne({ _id: txn._id });
    throw E.paymentRequired('Your balance is too low for this payment.');
  }

  // From here on the customer has been charged. Any unexpected failure must leave the Txn
  // Pending and flagged for review. It must never throw, because a retry would charge again.
  const flagForReview = async (why) => {
    log.error('Post-debit problem', { reference: txn.reference, subtype, why });
    await Txn.updateOne({ _id: txn._id }, { $set: { needsReview: true, failureReason: 'Awaiting confirmation.' } }).catch(() => {});
    const pending = await Txn.findById(txn._id).lean().catch(() => null);
    return { txn: pending || { ...txn.toObject(), needsReview: true }, balanceMinor: after.balanceMinor };
  };

  try {
    await Txn.updateOne({ _id: txn._id }, { $set: { debited: true, balanceAfterMinor: after.balanceMinor } });
  } catch (err) {
    return flagForReview(err && err.message);
  }

  let result;
  try {
    result = (await perform(txn)) || {};
  } catch (err) {
    const notConfigured = err instanceof NotConfiguredError;
    const failed = notConfigured || (err instanceof ProviderError && err.outcome === 'failed');
    if (failed) {
      const message = notConfigured ? 'This service is not available yet.' : err.message;
      try {
        const refund = await creditWallet(user._id, totalMinor, `refund:${txn._id}`);
        await Txn.updateOne({ _id: txn._id }, { $set: { status: 'Failed', failureReason: message } });
        await reverse(txn, refund.balanceMinor, message);
      } catch (refundErr) {
        return flagForReview(`refund failed: ${refundErr && refundErr.message}`);
      }
      if (notConfigured) throw E.unavailable(`${message} You have not been charged.`, 'PROVIDER_NOT_CONFIGURED');
      throw E.upstream(`${message} Your money has been returned.`, err.code === 'PROVIDER_ERROR' ? 'PAYMENT_FAILED' : err.code);
    }
    // Unknown outcome: keep the debit, flag for review.
    return flagForReview(err && err.message);
  }

  try {
    const set = { status: 'Successful' };
    if (result.providerRef) set.providerRef = result.providerRef;
    if (result.token) set.token = result.token;
    if (result.details) {
      set.details = { ...details, ...result.details };
      set.search = searchText([txn.reference, subtype, Object.values(set.details)]);
    }
    await Txn.updateOne({ _id: txn._id }, { $set: set });
    const done = await Txn.findById(txn._id).lean();
    return { txn: done, balanceMinor: after.balanceMinor };
  } catch (err) {
    return flagForReview(err && err.message);
  }
}

/**
 * Credit-side payment initiated by the user (mobile money top-up, card top-up).
 * `perform(txn)` collects the money from the partner first.
 */
async function payCredit({ user, kind, subtype, code, amountMinor, feeMinor = 0, details = {}, perform }) {
  assertCanTransact(user);
  const txn = await createWithReference(Txn, code, (reference) => ({
    user: user._id,
    reference,
    kind,
    subtype,
    direction: 'credit',
    amountMinor,
    feeMinor,
    totalMinor: amountMinor,
    status: 'Pending',
    details,
    ownerName: fullName(user),
    ownerAccount: user.accountNumber,
    search: searchText([reference, subtype, Object.values(details)]),
  }));

  let result;
  try {
    result = (await perform(txn)) || {};
  } catch (err) {
    const notConfigured = err instanceof NotConfiguredError;
    const failed = notConfigured || (err instanceof ProviderError && err.outcome === 'failed');
    if (failed) {
      const message = notConfigured ? 'This service is not available yet.' : err.message;
      await Txn.updateOne({ _id: txn._id }, { $set: { status: 'Failed', failureReason: message } });
      if (notConfigured) throw E.unavailable(`${message} You have not been charged.`, 'PROVIDER_NOT_CONFIGURED');
      throw E.upstream(message, err.code === 'PROVIDER_ERROR' ? 'PAYMENT_FAILED' : err.code);
    }
    log.error('Collection outcome unknown', { reference: txn.reference, subtype, message: err && err.message });
    await Txn.updateOne({ _id: txn._id }, { $set: { needsReview: true, failureReason: 'Awaiting confirmation from the provider.' } });
    const pending = await Txn.findById(txn._id).lean();
    const cur = await User.findById(user._id).select('balanceMinor');
    return { txn: pending, balanceMinor: cur.balanceMinor };
  }

  const credit = await creditWallet(user._id, amountMinor, `credit:${txn._id}`);
  await Txn.updateOne(
    { _id: txn._id },
    { $set: { status: 'Successful', balanceAfterMinor: credit.balanceMinor, ...(result.providerRef ? { providerRef: result.providerRef } : {}) } },
  );
  const done = await Txn.findById(txn._id).lean();
  return { txn: done, balanceMinor: credit.balanceMinor };
}

/**
 * Credit that arrives from outside (bank webhook, settlement, refund). `externalRef` is globally
 * unique, so calling this twice with the same ref credits once. Returns { txn, balanceMinor, duplicate }.
 */
async function applyExternalCredit({ userId, kind, subtype, code, amountMinor, feeMinor = 0, details = {}, externalRef }) {
  const user = await User.findById(userId).select('firstName lastName accountNumber balanceMinor');
  if (!user) throw E.notFound('Account not found.');
  let txn;
  try {
    txn = await createWithReference(Txn, code, (reference) => ({
      user: user._id,
      reference,
      kind,
      subtype,
      direction: 'credit',
      amountMinor,
      feeMinor,
      totalMinor: amountMinor,
      status: 'Pending',
      details,
      ownerName: fullName(user),
      ownerAccount: user.accountNumber,
      search: searchText([reference, subtype, Object.values(details)]),
      externalRef,
    }));
  } catch (err) {
    if (!isDuplicateKey(err, 'externalRef')) throw err;
    txn = await Txn.findOne({ externalRef });
    if (!txn) throw err;
    if (txn.status === 'Successful') {
      // Already applied: report it without touching the wallet again.
      const cur = await User.findById(user._id).select('balanceMinor');
      return { txn: txn.toObject(), balanceMinor: cur.balanceMinor, duplicate: true };
    }
  }
  const credit = await creditWallet(user._id, amountMinor, externalRef);
  if (txn.status !== 'Successful') {
    await Txn.updateOne({ _id: txn._id }, { $set: { status: 'Successful', balanceAfterMinor: credit.balanceMinor } });
  }
  const done = await Txn.findById(txn._id).lean();
  return { txn: done, balanceMinor: credit.balanceMinor, duplicate: !credit.applied };
}

module.exports = { fullName, searchText, assertCanTransact, debitWallet, creditWallet, payDebit, payCredit, applyExternalCredit };
