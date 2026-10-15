'use strict';
/**
 * Phone POS: a merchant asks a customer to pay by mobile money (Monime payment code).
 * When the payment is confirmed it becomes a POS payment (kind 'momo') and is paid out to the
 * merchant's wallet by the normal daily settlement. Everything here is idempotent.
 */
const { PosCharge, PosPayment } = require('../models');
const providers = require('../providers');
const env = require('../config/env');
const { isDuplicateKey } = require('../utils/references');
const log = require('../utils/log');

const PHONE_TERMINAL = 'PHONE';

/** Marks the charge paid (once) and records the POS payment. */
async function markPaid(chargeId) {
  const won = await PosCharge.findOneAndUpdate(
    { _id: chargeId, status: { $in: ['Pending', 'Expired'] } },
    { $set: { status: 'Paid', paidAt: new Date() }, $unset: { failureReason: 1 } },
    { new: true },
  );
  const charge = won || (await PosCharge.findById(chargeId));
  if (!charge || charge.status !== 'Paid') return { changed: false };
  try {
    await PosPayment.create({
      terminalCode: PHONE_TERMINAL,
      owner: charge.owner,
      amountMinor: charge.amountMinor,
      kind: 'momo',
      payer: charge.customerName || `+232 ${charge.customerPhone}`,
      reference: charge.reference,
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  return { changed: !!won };
}

async function markFailed(chargeId, status, reason) {
  const r = await PosCharge.updateOne({ _id: chargeId, status: 'Pending' }, { $set: { status, failureReason: reason } });
  return { changed: r.modifiedCount > 0 };
}

/** Asks the provider for the real state of a Pending charge. */
async function refresh(charge) {
  if (!charge || charge.status !== 'Pending' || !charge.providerRef) return { changed: false };
  try {
    const s = await providers.paymentCode.status(charge.providerRef);
    if (s.paid) return markPaid(charge._id);
    if (s.expired) return markFailed(charge._id, 'Expired', 'The payment code expired before the customer paid.');
  } catch (err) {
    log.warn('POS charge check failed', { reference: charge.reference, message: err && err.message });
  }
  return { changed: false };
}

const lastLook = new Map();
/** Throttled refresh used while the app polls. */
async function refreshThrottled(charge) {
  if (env.providerMode !== 'live') return { changed: false };
  const now = Date.now();
  if (now - (lastLook.get(String(charge._id)) || 0) < 3000) return { changed: false };
  lastLook.set(String(charge._id), now);
  if (lastLook.size > 5000) lastLook.clear();
  return refresh(charge);
}

async function refreshByProviderRef(providerRef) {
  const charge = await PosCharge.findOne({ providerRef });
  if (!charge) return { handled: false };
  return { handled: true, ...(await refresh(charge)) };
}

module.exports = { markPaid, markFailed, refresh, refreshThrottled, refreshByProviderRef };
