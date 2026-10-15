'use strict';
/**
 * Account tiers and their limits.
 *   Tier 1 · Basic    : Le 100 a day, Le 500 balance (every new account, once an admin approves it)
 *   Tier 2 · Verified : Le 500 a day, Le 1,000 balance (proof of address)
 *   Tier 3 · Premium  : business accounts with POS, no limits (business documents)
 * Admins can change the numbers (stored in Setting 'tierLimits'). `null` means unlimited.
 */
const { Setting, Txn, User } = require('../models');
const { E } = require('../utils/errors');
const { startOfDayUtc } = require('../utils/time');
const { formatLe } = require('../utils/money');

const TIERS = ['Tier 1 · Basic', 'Tier 2 · Verified', 'Tier 3 · Premium'];

// Minor units (Le x 100).
const DEFAULTS = {
  'Tier 1 · Basic': { dailyMinor: 100 * 100, balanceMinor: 500 * 100 },
  'Tier 2 · Verified': { dailyMinor: 500 * 100, balanceMinor: 1000 * 100 },
  'Tier 3 · Premium': { dailyMinor: null, balanceMinor: null },
};

let cache = { at: 0, value: DEFAULTS };

async function getLimits() {
  if (Date.now() - cache.at < 15000) return cache.value;
  const doc = await Setting.findOne({ key: 'tierLimits' }).lean().catch(() => null);
  const merged = {};
  for (const t of TIERS) merged[t] = { ...DEFAULTS[t], ...((doc && doc.value && doc.value[t]) || {}) };
  cache = { at: Date.now(), value: merged };
  return merged;
}

async function setLimits(next) {
  const cur = await getLimits();
  const value = {};
  for (const t of TIERS) value[t] = { ...cur[t], ...(next[t] || {}) };
  await Setting.updateOne({ key: 'tierLimits' }, { $set: { value } }, { upsert: true });
  cache = { at: 0, value: DEFAULTS };
  return getLimits();
}

const spentToday = async (userId) => {
  const rows = await Txn.aggregate([
    { $match: { user: userId, direction: 'debit', status: { $in: ['Pending', 'Successful'] }, createdAt: { $gte: startOfDayUtc() } } },
    { $group: { _id: null, total: { $sum: '$totalMinor' } } },
  ]);
  return rows[0] ? rows[0].total : 0;
};

// Needed to open a POS terminal in the first place, so it is not counted against the daily limit.
const EXEMPT_SUBTYPES = new Set(['pos_request']);

/** Throws when this payment would take the user over their tier's daily limit. */
async function assertCanSpend(user, totalMinor, subtype) {
  if (EXEMPT_SUBTYPES.has(subtype)) return;
  const limit = (await getLimits())[user.tier];
  if (!limit || limit.dailyMinor == null) return;
  const used = await spentToday(user._id);
  if (used + totalMinor > limit.dailyMinor) {
    const left = Math.max(0, limit.dailyMinor - used);
    throw E.forbidden(
      `This is over your daily limit of ${formatLe(limit.dailyMinor)} for ${user.tier}. You can still spend ${formatLe(left)} today. Upgrade your account in Profile to raise it.`,
      'DAILY_LIMIT',
    );
  }
}

/** Throws when receiving `amountMinor` would take the account over its tier's balance cap. */
async function assertCanReceive(userId, amountMinor, { self = true } = {}) {
  const u = await User.findById(userId).select('tier balanceMinor');
  if (!u) return;
  const limit = (await getLimits())[u.tier];
  if (!limit || limit.balanceMinor == null) return;
  if ((u.balanceMinor || 0) + amountMinor > limit.balanceMinor) {
    throw E.forbidden(
      self
        ? `This would take your balance over the ${formatLe(limit.balanceMinor)} limit for ${u.tier}. Upgrade your account in Profile to hold more.`
        : 'This account cannot receive that amount right now.',
      'BALANCE_LIMIT',
    );
  }
}

async function usage(user) {
  const limits = await getLimits();
  const l = limits[user.tier] || DEFAULTS[TIERS[0]];
  return { limits: l, usedTodayMinor: await spentToday(user._id) };
}

module.exports = { TIERS, DEFAULTS, getLimits, setLimits, assertCanSpend, assertCanReceive, usage };
