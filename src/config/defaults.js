'use strict';
/**
 * Default catalog / pricing. Seeded into the `Config` document (key "app") by `npm run seed`,
 * and used as an in-code fallback so a fresh deploy works before seeding.
 * All prices/fees are INTEGER minor units (Le x 100). Values are placeholders on the NEW leone
 * scale; real vendor prices come from your partners.
 */
const { le } = require('../utils/money');

const sub = (name, subtitle) => ({ name, subtitle });

module.exports = {
  banks: [
    'Rokel Commercial Bank',
    'Sierra Leone Commercial Bank',
    'Ecobank',
    'GTBank',
    'Union Trust Bank',
    'Access Bank',
    'First Bank',
    'Zenith Bank',
  ],
  mobileMoney: ['Orange Money', 'Afrimoney', 'Qmoney'],
  networks: ['Orange', 'Africell', 'Qcell'],
  electricity: [
    sub('EDSA Cash Power', 'Prepaid · Freetown'),
    sub('EDSA Cash Power (Provinces)', 'Prepaid · Bo, Kenema, Makeni'),
    sub('EDSA Postpaid', 'Postpaid · Freetown'),
  ],
  tv: [
    sub('DStv', 'Subscriptions · Sierra Leone'),
    sub('GOtv', 'Subscriptions · Sierra Leone'),
    sub('StarTimes', 'Subscriptions · Sierra Leone'),
  ],
  internet: [
    sub('Orange Internet', 'Data plans · Sierra Leone'),
    sub('Africell Data', 'Data plans · Sierra Leone'),
    sub('Sierratel', 'Broadband · Freetown'),
  ],
  dataPlans: [
    { id: 'data-500mb-7d', size: '500 MB', days: 7, priceMinor: le(25) },
    { id: 'data-1500mb-30d', size: '1.5 GB', days: 30, priceMinor: le(75) },
    { id: 'data-3gb-30d', size: '3 GB', days: 30, priceMinor: le(125) },
    { id: 'data-10gb-30d', size: '10 GB', days: 30, priceMinor: le(300) },
  ],
  tvPackages: [
    { id: 'tv-basic', name: 'Basic', detail: 'Essential channels · 1 month', priceMinor: le(150) },
    { id: 'tv-standard', name: 'Standard', detail: 'More sport and movies · 1 month', priceMinor: le(300) },
    { id: 'tv-premium', name: 'Premium', detail: 'Everything, in HD · 1 month', priceMinor: le(600) },
  ],
  internetPackages: [
    { id: 'net-starter', name: 'Starter', detail: '20 GB · 30 days', priceMinor: le(250) },
    { id: 'net-plus', name: 'Plus', detail: '50 GB · 30 days', priceMinor: le(500) },
    { id: 'net-max', name: 'Max', detail: '100 GB · 30 days', priceMinor: le(900) },
  ],
  feesMinor: {
    transfer: le(1),
    mobileMoneySend: le(1),
    bill: 0,
    cardIssuance: le(50),
    physicalCard: le(100),
    terminalDeposit: le(1500),
    terminalDelivery: le(125),
  },
  // Percentage fees in basis points (150 = 1.5 %). Additive to the contract.
  feeRatesBps: { cardFunding: 150 },
  terminal: {
    categories: ['Retail / General merchandise', 'Food & beverage', 'Services', 'Other'],
    districts: ['Freetown', 'Western Area Rural', 'Bo', 'Makeni', 'Kenema', 'Koidu'],
  },
  topics: ['Transfer', 'Bill payment', 'Airtime / data', 'Card', 'POS', 'Something else'],
  support: {
    phone: '+232 00 000 000',
    email: 'support@trustpay.example',
    hours: 'Mon–Sat · 08:00–18:00',
  },
};
