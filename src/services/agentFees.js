'use strict';
/**
 * Agent cash-out pricing (admin editable, Setting 'agentFees'):
 *   cashOutBps  fee the customer pays on a cash-out, in basis points (100 = 1 %)
 *   minFeeMinor smallest fee in minor units
 *   agentSharePct  share of that fee the agent keeps as commission (the rest is TrustPay's)
 * Cash-in (agent puts money into a customer's wallet) is free for the customer.
 */
const { Setting } = require('../models');

const DEFAULTS = { cashOutBps: 100, minFeeMinor: 100, agentSharePct: 70 };
let cache = { at: 0, value: DEFAULTS };

async function getFees() {
  if (Date.now() - cache.at < 15000) return cache.value;
  const doc = await Setting.findOne({ key: 'agentFees' }).lean().catch(() => null);
  const value = { ...DEFAULTS, ...((doc && doc.value) || {}) };
  cache = { at: Date.now(), value };
  return value;
}

async function setFees(next) {
  const cur = await getFees();
  const value = { ...cur, ...next };
  await Setting.updateOne({ key: 'agentFees' }, { $set: { value } }, { upsert: true });
  cache = { at: 0, value: DEFAULTS };
  return getFees();
}

/** Fee and agent commission for withdrawing `amountMinor` in cash. */
async function cashOutQuote(amountMinor) {
  const f = await getFees();
  const feeMinor = Math.max(f.minFeeMinor, Math.round((amountMinor * f.cashOutBps) / 10000));
  const commissionMinor = Math.floor((feeMinor * f.agentSharePct) / 100);
  return { feeMinor, commissionMinor, totalMinor: amountMinor + feeMinor };
}

module.exports = { DEFAULTS, getFees, setFees, cashOutQuote };
