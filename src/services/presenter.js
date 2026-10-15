'use strict';
/**
 * Turns stored documents into the JSON the Flutter app expects (see lib/models/models.dart).
 * Titles, meta lines and receipts are built here so every client shows the same wording.
 */
const { fromMinor, formatLe } = require('../utils/money');
const { hhmm, dateTime } = require('../utils/time');
const { formatLocal } = require('../utils/phone');

const iso = (d) => (d ? new Date(d).toISOString() : null);

function presentUser(u) {
  return {
    id: String(u._id),
    firstName: u.firstName,
    lastName: u.lastName,
    fullName: `${u.firstName} ${u.lastName}`.trim(),
    email: u.email,
    phone: formatLocal(u.phone),
    accountNumber: u.accountNumber,
    businessName: u.businessName || '',
    address: u.address || '',
    tier: u.tier,
    role: u.role,
    status: u.status,
    onboardingStep: u.onboardingStep,
    hasPin: !!u.hasPin,
    balance: fromMinor(u.balanceMinor),
    createdAt: iso(u.createdAt),
  };
}

const maskAcct = (n) => (n ? `•• ${String(n).slice(-4)}` : '');
const phoneOf = (p) => (p ? formatLocal(p) : '');

/** Per-subtype wording. `d` = txn.details. */
const KINDS = {
  transfer_bank_out: {
    label: 'Bank transfer',
    title: (d) => `To ${d.accountName || 'bank account'}`,
    banner: (d) => `Sent to ${d.accountName || 'bank account'}`,
    eyebrow: 'TRANSACTIONS · TRANSFER RECEIPT',
    rows: (d) => [['Recipient', d.accountName || '—'], ['Bank / account', `${d.bank} · ${d.accountNumber}`], ...(d.note ? [['Note', d.note]] : [])],
  },
  transfer_user_out: {
    label: 'TrustPay transfer',
    title: (d) => `To ${d.accountName || 'TrustPay user'}`,
    banner: (d) => `Sent to ${d.accountName || 'TrustPay user'}`,
    eyebrow: 'TRANSACTIONS · TRANSFER RECEIPT',
    rows: (d) => [['Recipient', d.accountName || '—'], ['TrustPay account', d.accountNumber || '—'], ...(d.note ? [['Note', d.note]] : [])],
  },
  transfer_user_in: {
    label: 'TrustPay transfer',
    title: (d) => `From ${d.senderName || 'TrustPay user'}`,
    banner: (d) => `Received from ${d.senderName || 'TrustPay user'}`,
    eyebrow: 'TRANSACTIONS · RECEIPT',
    rows: (d) => [['Sender', d.senderName || '—'], ['TrustPay account', d.senderAccount || '—'], ...(d.note ? [['Note', d.note]] : [])],
  },
  mm_send: {
    label: 'Mobile money',
    title: (d) => `To ${d.holderName || d.provider}`,
    banner: (d) => `Sent to ${d.holderName || d.provider}`,
    eyebrow: 'TRANSACTIONS · MOBILE MONEY RECEIPT',
    rows: (d) => [['Wallet', d.provider], ['Number', phoneOf(d.number)], ['Account name', d.holderName || '—']],
  },
  mm_add: {
    label: 'Mobile money',
    title: (d) => `From ${d.provider}`,
    banner: (d) => `Added from ${d.provider}`,
    eyebrow: 'TRANSACTIONS · FUNDING RECEIPT',
    rows: (d) => [['Wallet', d.provider], ['Number', phoneOf(d.number)], ['Account name', d.holderName || '—']],
  },
  funding_bank: {
    label: 'Bank transfer',
    title: () => 'Account funding',
    banner: (d) => (d.sender ? `Received from ${d.sender}` : 'Account funding'),
    eyebrow: 'TRANSACTIONS · FUNDING RECEIPT',
    rows: (d) => [...(d.sender ? [['Sender', d.sender]] : []), ['Method', 'Bank transfer']],
  },
  funding_checkout: {
    label: 'Card',
    title: () => 'Account funding',
    banner: () => 'Added by card',
    eyebrow: 'TRANSACTIONS · FUNDING RECEIPT',
    rows: () => [['Method', 'Card']],
  },
  funding_momo_code: {
    label: 'Mobile money',
    title: (d) => `From ${d.provider}`,
    banner: (d) => `Added from ${d.provider}`,
    eyebrow: 'TRANSACTIONS · FUNDING RECEIPT',
    rows: (d) => [['Wallet', d.provider], ['Number', phoneOf(d.number)]],
  },
  funding_card: {
    label: 'Card',
    title: () => 'Account funding',
    banner: () => 'Added by card',
    eyebrow: 'TRANSACTIONS · FUNDING RECEIPT',
    rows: (d) => [['Method', `${d.brand || 'Card'} •• ${d.last4}`]],
  },
  bill_electricity: {
    label: 'Electricity',
    title: (d) => d.provider,
    banner: (d) => `Paid ${d.provider}`,
    eyebrow: 'TRANSACTIONS · BILL RECEIPT',
    rows: (d) => [
      ['Provider', d.provider],
      ['Type', d.prepaid ? 'Prepaid' : 'Postpaid'],
      ['Meter number', d.meter],
      ...(d.customer ? [['Customer', d.customer]] : []),
      ...(d.units ? [['Units', `${d.units} kWh`]] : []),
      ['SMS to', phoneOf(d.phone)],
    ],
  },
  bill_tv: {
    label: 'TV',
    title: (d) => `${d.provider} ${d.packageName || ''}`.trim(),
    banner: (d) => `Paid ${d.provider}`,
    eyebrow: 'TRANSACTIONS · BILL RECEIPT',
    rows: (d) => [['Provider', d.provider], ['Package', d.packageName || '—'], ['Account / smartcard', d.number], ['SMS to', phoneOf(d.phone)]],
  },
  bill_internet: {
    label: 'Internet',
    title: (d) => `${d.provider} ${d.packageName || ''}`.trim(),
    banner: (d) => `Paid ${d.provider}`,
    eyebrow: 'TRANSACTIONS · BILL RECEIPT',
    rows: (d) => [['Provider', d.provider], ['Package', d.packageName || '—'], ['Account number', d.number], ['SMS to', phoneOf(d.phone)]],
  },
  airtime: {
    label: 'Airtime',
    title: (d) => `${d.network} Airtime`,
    banner: (d) => `Airtime for ${phoneOf(d.phone)}`,
    eyebrow: 'TRANSACTIONS · AIRTIME RECEIPT',
    rows: (d) => [['Network', d.network], ['Phone number', phoneOf(d.phone)]],
  },
  data: {
    label: 'Data',
    title: (d) => `${d.network} ${d.planSize || 'Data'}`,
    banner: (d) => `${d.planSize || 'Data'} for ${phoneOf(d.phone)}`,
    eyebrow: 'TRANSACTIONS · DATA RECEIPT',
    rows: (d) => [['Network', d.network], ['Phone number', phoneOf(d.phone)], ['Bundle', `${d.planSize || ''}${d.days ? ` · ${d.days} days` : ''}`.trim()]],
  },
  card_issue: {
    label: 'Card',
    title: () => 'Virtual card created',
    banner: () => 'Virtual card created',
    eyebrow: 'TRANSACTIONS · CARD RECEIPT',
    rows: (d) => [['Card', `•••• ${d.last4}`], ['Loaded on card', formatLe(d.loadedMinor || 0)]],
  },
  card_fund: {
    label: 'Card',
    title: (d) => `Card •••• ${d.last4} top-up`,
    banner: (d) => `Added to card •••• ${d.last4}`,
    eyebrow: 'TRANSACTIONS · CARD RECEIPT',
    rows: (d) => [['Card', `•••• ${d.last4}`]],
  },
  card_physical: {
    label: 'Card',
    title: () => 'Physical card order',
    banner: () => 'Physical card ordered',
    eyebrow: 'TRANSACTIONS · CARD RECEIPT',
    rows: (d) => [['Name on card', d.name || '—'], ['Delivery', [d.address, d.city, d.state].filter(Boolean).join(', ')], ['Phone', phoneOf(d.phone)]],
  },
  pos_request: {
    label: 'POS',
    title: () => 'POS terminal request',
    banner: () => 'POS terminal request',
    eyebrow: 'TRANSACTIONS · POS RECEIPT',
    rows: (d) => [['Business', d.businessName || '—'], ['Refundable deposit', formatLe(d.depositMinor || 0)], ['Delivery fee', formatLe(d.deliveryMinor || 0)]],
  },
  pos_settlement: {
    label: 'POS settlement',
    title: () => 'POS settlement',
    banner: () => 'POS settlement',
    eyebrow: 'TRANSACTIONS · SETTLEMENT RECEIPT',
    rows: (d) => [['Payments', String(d.count || 0)], ['Gross', formatLe(d.grossMinor || 0)], ['Fees', formatLe(d.feeMinor || 0)]],
  },
  pos_refund: {
    label: 'POS',
    title: () => 'POS request refund',
    banner: () => 'POS request refunded',
    eyebrow: 'TRANSACTIONS · REFUND RECEIPT',
    rows: (d) => (d.reason ? [['Reason', d.reason]] : []),
  },
  reversal: {
    label: 'Reversal',
    title: (d) => `Refund · ${d.originalTitle || 'failed payment'}`,
    banner: () => 'Money returned',
    eyebrow: 'TRANSACTIONS · REVERSAL',
    rows: (d) => [['Original reference', d.originalReference || '—'], ...(d.reason ? [['Reason', d.reason]] : [])],
  },
};

const FALLBACK = { label: 'Transaction', title: () => 'Transaction', banner: () => 'Transaction', eyebrow: 'TRANSACTIONS · RECEIPT', rows: () => [] };
const kindOf = (subtype) => KINDS[subtype] || FALLBACK;

function present(t) {
  const d = t.details || {};
  const k = kindOf(t.subtype);
  const credit = t.direction === 'credit';
  const created = new Date(t.createdAt);
  const fee = fromMinor(t.feeMinor);
  const total = fromMinor(t.totalMinor);

  const meta = [hhmm(created), k.label, t.status].join(' · ') + (t.feeMinor > 0 && !credit ? ` · Includes ${formatLe(t.feeMinor)} fee` : '');

  const rows = [];
  if (credit) rows.push(['To account', `TrustPay · ${t.ownerAccount || ''}`]);
  else {
    rows.push(['Sender', t.ownerName || '—']);
    rows.push(['From account', `TrustPay · ${t.ownerAccount || ''}`]);
  }
  rows.push(...k.rows(d));
  rows.push(['Amount / fee', `${formatLe(t.amountMinor, { fixed: true })} / ${formatLe(t.feeMinor, { fixed: true })}`]);
  rows.push([credit ? 'Total credit' : 'Total debit', formatLe(t.totalMinor, { fixed: true })]);
  if (t.token) rows.push(['Token', t.token]);
  if (t.failureReason) rows.push(['Reason', t.failureReason]);
  rows.push(['Date & time', dateTime(created)]);
  rows.push(['Reference', t.reference]);

  return {
    id: String(t._id),
    reference: t.reference,
    kind: t.kind,
    direction: t.direction,
    title: k.title(d),
    meta,
    amount: credit ? total : -total,
    fee,
    status: t.status,
    createdAt: iso(t.createdAt),
    ...(t.token ? { token: t.token } : {}),
    receipt: {
      eyebrow: k.eyebrow,
      statusLine: `${t.status} · ${k.label}`,
      bannerLabel: k.banner(d),
      amount: fromMinor(t.amountMinor),
      rows,
    },
  };
}

function presentCard(c) {
  const mm = String(c.expiryMonth || '').padStart(2, '0');
  const yy = String((c.expiryYear || 0) % 100).padStart(2, '0');
  return {
    id: String(c._id),
    type: c.type,
    last4: c.last4,
    expiry: c.expiryMonth ? `${mm}/${yy}` : '',
    holder: c.holder,
    balance: fromMinor(c.balanceMinor),
    frozen: !!c.frozen,
    status: c.frozen ? 'frozen' : c.status,
    issuancePaid: fromMinor(c.issuancePaidMinor || 0),
  };
}

function presentTerminal(t) {
  if (!t) return null;
  return {
    id: String(t._id),
    code: t.code,
    serial: t.serial,
    status: t.status,
    lastSync: iso(t.lastSyncAt),
    location: t.location || '',
    connection: t.connection || '',
    battery: t.battery == null ? null : t.battery,
  };
}

function presentPosRequest(r) {
  if (!r) return null;
  return {
    id: String(r._id),
    reference: r.reference,
    status: r.status,
    createdAt: iso(r.createdAt),
    expectedFrom: iso(r.expectedFrom),
    expectedTo: iso(r.expectedTo),
  };
}

function presentTicket(t, { withUser = false, user } = {}) {
  return {
    id: String(t._id),
    reference: t.reference,
    topic: t.topic,
    status: t.status,
    createdAt: iso(t.createdAt),
    lastMessage: t.lastMessage && t.lastMessage.text ? t.lastMessage.text : null,
    ...(withUser && user ? { user: { fullName: `${user.firstName} ${user.lastName}`.trim() } } : {}),
  };
}

const presentMessage = (m) => ({ id: String(m._id), from: m.from, text: m.text, createdAt: iso(m.createdAt) });

module.exports = { iso, presentUser, present, presentCard, presentTerminal, presentPosRequest, presentTicket, presentMessage };
