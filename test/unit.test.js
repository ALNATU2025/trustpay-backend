'use strict';
// Pure-logic tests: no database and no network needed.
process.env.NODE_ENV = 'test';
process.env.BCRYPT_COST = '4';
const test = require('node:test');
const assert = require('node:assert/strict');

const { toMinor, fromMinor, bpsOf, formatLe, le } = require('../src/utils/money');
const { normalisePhone, formatLocal } = require('../src/utils/phone');
const { isLuhnValid, generatePan } = require('../src/utils/luhn');
const { makeReference } = require('../src/utils/references');
const S = require('../src/validators/schemas');
const { present } = require('../src/services/presenter');
const { presentCatalog } = require('../src/services/catalogPresenter');
const defaults = require('../src/config/defaults');

test('money: parses Leones into minor units safely', () => {
  assert.equal(toMinor(12.5), 1250);
  assert.equal(toMinor('1500'), 150000);
  assert.equal(toMinor(0.1 + 0.2), 30);
  assert.throws(() => toMinor(0), /greater than zero/);
  assert.throws(() => toMinor(-5), /greater than zero/);
  assert.throws(() => toMinor(1.005), /2 decimal/);
  assert.throws(() => toMinor('abc'), /number/);
  assert.throws(() => toMinor(1e12), /maximum/);
  assert.equal(fromMinor(123456), 1234.56);
  assert.equal(bpsOf(100000, 150), 1500);
  assert.equal(formatLe(150000), 'Le 1,500');
  assert.equal(formatLe(le(1250.5)), 'Le 1,250.50');
});

test('phone: every Sierra Leone format maps to the same stored number', () => {
  for (const p of ['076 123 456', '076123456', '+232 76 123 456', '+23276123456', '0023276123456', '76123456']) {
    assert.equal(normalisePhone(p), '76123456', p);
  }
  assert.equal(normalisePhone('12345'), null);
  assert.equal(normalisePhone('abc'), null);
  assert.equal(formatLocal('76123456'), '076 123 456');
});

test('luhn: generated card numbers are valid', () => {
  for (let i = 0; i < 20; i++) assert.ok(isLuhnValid(generatePan('400000', 16)));
  assert.ok(!isLuhnValid('4000001234567890'));
});

test('references look like TP-TRF-DDMMYY-NNNN', () => {
  assert.match(makeReference('TRF'), /^TP-TRF-\d{6}-\d{4}$/);
});

test('validators: sign up rules', () => {
  const ok = { firstName: 'Aminata', lastName: 'Kamara', email: 'A@Example.com', phone: '+232 76 123 456', password: 'Strong#123' };
  const r = S.register.parse(ok);
  assert.equal(r.email, 'a@example.com');
  assert.equal(r.phone, '76123456');
  assert.throws(() => S.register.parse({ ...ok, password: 'short1!' }));
  assert.throws(() => S.register.parse({ ...ok, password: 'NoDigits!!' }));
  assert.throws(() => S.register.parse({ ...ok, password: 'NoSymbol123' }));
  assert.throws(() => S.register.parse({ ...ok, phone: '123' }));
});

test('validators: amounts become minor units and PIN must be 4 digits', () => {
  const r = S.airtime.parse({ network: 'Orange', phone: '076123456', amount: 25, pin: '4829' });
  assert.equal(r.amount, 2500);
  assert.throws(() => S.airtime.parse({ network: 'Orange', phone: '076123456', amount: 25, pin: '48' }));
  assert.throws(() => S.airtime.parse({ network: 'Orange', phone: '076123456', amount: -1, pin: '4829' }));
});

test('validators: under-18 date of birth is rejected', () => {
  const base = { legalName: 'Aminata Kamara', idType: 'NIN', idNumber: '12345678901', address: '12 Wilberforce Street' };
  assert.ok(S.identity.parse({ ...base, dob: '1990-05-01' }).dob instanceof Date);
  const young = new Date(Date.now() - 10 * 365 * 86400000).toISOString().slice(0, 10);
  assert.throws(() => S.identity.parse({ ...base, dob: young }));
});

test('catalog: prices are served in Leones, not minor units', () => {
  const c = presentCatalog(defaults);
  assert.equal(c.fees.transfer, 1);
  assert.equal(c.fees.terminalDeposit, 1500);
  assert.equal(c.dataPlans[0].price, 25);
  assert.ok(c.tvPackages.every((p) => typeof p.price === 'number' && p.price < 10000));
});

test('presenter: debit transfer shows a negative total and a receipt', () => {
  const t = present({
    _id: 'abc',
    reference: 'TP-TRF-151026-1234',
    kind: 'transfer',
    subtype: 'transfer_bank_out',
    direction: 'debit',
    amountMinor: 125000,
    feeMinor: 100,
    totalMinor: 125100,
    status: 'Successful',
    details: { bank: 'Ecobank', accountNumber: '0123456789', accountName: 'Fatmata Conteh', note: 'October supplies' },
    ownerName: 'Aminata Kamara',
    ownerAccount: '0123454821',
    createdAt: new Date('2026-10-15T12:50:00Z'),
  });
  assert.equal(t.amount, -1251);
  assert.equal(t.fee, 1);
  assert.equal(t.title, 'To Fatmata Conteh');
  assert.match(t.meta, /^12:50 · Bank transfer · Successful · Includes Le 1 fee$/);
  assert.equal(t.receipt.amount, 1250);
  assert.ok(t.receipt.rows.some(([k, v]) => k === 'Reference' && v === 'TP-TRF-151026-1234'));
  assert.ok(t.receipt.rows.every((r) => Array.isArray(r) && r.length === 2));
});

test('presenter: credits are positive and carry the electricity token', () => {
  const t = present({
    _id: 'x', reference: 'TP-BIL-151026-1', kind: 'bill', subtype: 'bill_electricity', direction: 'debit',
    amountMinor: 62500, feeMinor: 0, totalMinor: 62500, status: 'Successful', token: '1234 5678 9012 3456 7890',
    details: { provider: 'EDSA Cash Power', prepaid: true, meter: '12345678901', customer: 'Test', phone: '76123456' },
    ownerName: 'A B', ownerAccount: '1', createdAt: new Date(),
  });
  assert.equal(t.token, '1234 5678 9012 3456 7890');
  assert.equal(t.amount, -625);
  const c = present({
    _id: 'y', reference: 'TP-ADD-151026-2', kind: 'funding', subtype: 'funding_bank', direction: 'credit',
    amountMinor: 500000, feeMinor: 0, totalMinor: 500000, status: 'Successful', details: { sender: 'Rokel Commercial Bank' },
    ownerName: 'A B', ownerAccount: '1', createdAt: new Date(),
  });
  assert.equal(c.amount, 5000);
  assert.equal(c.title, 'Account funding');
});

test('monime: webhook signature accepts HMAC (hex/base64) and HS256 JWT, rejects tampering', () => {
  const crypto = require('crypto');
  const env = require('../src/config/env');
  env.monime.webhookSecret = 's'.repeat(40);
  const { checkSignature } = require('../src/services/monime');
  const raw = Buffer.from('{"event":{"name":"payout.completed"}}');
  const req = (headers) => ({ rawBody: raw, get: (h) => headers[h.toLowerCase()] });
  const mac = crypto.createHmac('sha256', env.monime.webhookSecret).update(raw);
  const hex = mac.digest('hex');
  assert.equal(checkSignature(req({ 'monime-signature': hex })), 'ok');
  assert.equal(checkSignature(req({ 'x-signature': `sha256=${hex}` })), 'ok');
  assert.equal(checkSignature(req({ 'monime-signature': 'deadbeef' })), 'bad');
  const jwt = require('jsonwebtoken').sign({ a: 1 }, env.monime.webhookSecret, { algorithm: 'HS256', expiresIn: 60 });
  assert.equal(checkSignature(req({ 'monime-signature': jwt })), 'ok');
  assert.equal(checkSignature(req({})), 'none');
  env.monime.webhookSecret = '';
  assert.equal(checkSignature(req({ 'monime-signature': 'x' })), 'none');
});
