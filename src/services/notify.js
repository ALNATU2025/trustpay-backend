'use strict';
/**
 * Notifications: an inbox entry per person (shown in the app) plus an optional phone push.
 * Everything here is best effort: a notification problem must never break a payment or a signup.
 *   notifyUser(userId, { type, title, body, data })
 *   notifyAdmins(category, { title, body, data })   category: signup | funding | payment | approval | alert
 *   broadcast({ by, audience, tier, userId, kind, title, body })
 */
const { User, Notification, Broadcast, Terminal } = require('../models');
const env = require('../config/env');
const push = require('./push');
const log = require('../utils/log');
const { formatLe } = require('../utils/money');

const safe = (p) => p.catch((e) => log.warn('Notification failed', { message: e && e.message }));

async function pushTo(users, { title, body, type, data }) {
  if (!push.enabled()) return;
  const tokens = users.flatMap((u) => u.deviceTokens || []);
  if (!tokens.length) return;
  const dead = await push.send(tokens, { title, body, data: { type, ...(data || {}) } });
  if (dead.length) await User.updateMany({ deviceTokens: { $in: dead } }, { $pull: { deviceTokens: { $in: dead } } }).catch(() => {});
}

async function notifyUser(userId, { type = 'update', title, body = '', data = {} }) {
  return safe(
    (async () => {
      await Notification.create({ user: userId, type, title, body, data });
      const u = await User.findById(userId).select('+deviceTokens').lean();
      if (u) await pushTo([u], { title, body, type, data });
    })(),
  );
}

async function staffList(category) {
  const staff = await User.find({ $or: [{ role: 'admin' }, { _id: { $in: env.superAdminIds.filter((x) => /^[a-f0-9]{24}$/i.test(x)) } }] })
    .select('+deviceTokens notifyPrefs')
    .lean();
  return staff.filter((u) => !(u.notifyPrefs && u.notifyPrefs[category] === false));
}

async function notifyAdmins(category, { title, body = '', data = {} }) {
  return safe(
    (async () => {
      const staff = await staffList(category);
      if (!staff.length) return;
      await Notification.insertMany(staff.map((u) => ({ user: u._id, type: category, title, body, data })));
      await pushTo(staff, { title, body, type: category, data });
    })(),
  );
}

async function audienceFilter({ audience, tier, userId }) {
  const base = { role: 'user' };
  if (audience === 'user') return { ...base, _id: userId };
  if (audience === 'tier') return { ...base, tier };
  if (audience === 'merchants') {
    const owners = await Terminal.distinct('owner');
    return { ...base, $or: [{ _id: { $in: owners } }, { merchantCode: { $exists: true } }] };
  }
  return { ...base, onboardingStep: 'done' };
}

async function broadcast({ by, audience, tier, userId, kind = 'update', title, body = '' }) {
  const filter = await audienceFilter({ audience, tier, userId });
  let count = 0;
  const cursor = User.find(filter).select('+deviceTokens').cursor();
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const users = batch;
    batch = [];
    await Notification.insertMany(users.map((u) => ({ user: u._id, type: kind, title, body, data: {} })));
    count += users.length;
    await pushTo(users, { title, body, type: kind });
  };
  for await (const u of cursor) {
    batch.push(u);
    if (batch.length >= 500) await flush();
  }
  await flush();
  await Broadcast.create({ by, kind, title, body, audience, tier, user: userId, count });
  return count;
}

/** Wording for money arriving in a wallet. */
function creditText(txn) {
  const amount = formatLe(txn.amountMinor);
  const d = txn.details || {};
  switch (txn.subtype) {
    case 'funding_momo_code':
    case 'funding_checkout':
    case 'funding_card':
    case 'funding_bank':
      return { title: 'Wallet funded', body: `${amount} was added to your TrustPay wallet.` };
    case 'manual_credit':
      return { title: 'Account credited', body: `${amount} was added to your wallet by TrustPay.${d.reason ? ` Reason: ${d.reason}` : ''}` };
    case 'pos_settlement':
      return { title: 'POS settlement paid', body: `${amount} from your POS sales was paid to your wallet.` };
    case 'pos_refund':
      return { title: 'POS refund', body: `${amount} was returned to your wallet.` };
    default:
      return { title: 'Money received', body: `${amount} was added to your wallet.` };
  }
}

/** A credit has just been applied. Tell the owner, and tell admins about customer top-ups. */
async function creditApplied(txn, ownerName) {
  const t = creditText(txn);
  await notifyUser(txn.user, { type: 'funding', ...t, data: { reference: txn.reference } });
  if (/^funding|^mm_add/.test(txn.subtype || '')) {
    await notifyAdmins('funding', {
      title: 'Wallet funded',
      body: `${ownerName || txn.ownerName || 'A customer'} added ${formatLe(txn.amountMinor)} (${txn.subtype.replace(/_/g, ' ')}).`,
      data: { reference: txn.reference, userId: String(txn.user) },
    });
  }
}

module.exports = { notifyUser, notifyAdmins, broadcast, creditApplied };
