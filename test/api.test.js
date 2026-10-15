'use strict';
/**
 * Integration tests: real Express app + in-memory MongoDB. Run with `npm test`.
 * (Needs the dev dependencies: supertest and mongodb-memory-server.)
 */
process.env.NODE_ENV = 'test';
process.env.BCRYPT_COST = '4';
process.env.OTP_DEBUG = 'true';
process.env.PROVIDER_MODE = 'sandbox';
process.env.WEBHOOK_SECRET = 'test-webhook-secret-1234';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-1234567890';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

const { connect, disconnect } = require('../src/db');
const { createApp } = require('../src/app');
const { User, Txn } = require('../src/models');

let mongod;
let app;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await connect(mongod.getUri());
  app = createApp();
});

test.after(async () => {
  await disconnect();
  await mongod.stop();
});

let counter = 0;
/** Creates a fully onboarded user through the real API and returns { token, user, pin, phone }. */
async function onboard(overrides = {}) {
  counter += 1;
  const phone = `7600${String(counter).padStart(4, '0')}`;
  const body = { firstName: 'Test', lastName: `User${counter}`, email: `t${counter}@example.com`, phone, password: 'Strong#1234', ...overrides };
  const reg = await request(app).post('/api/auth/register').send(body).expect(201);
  const token = reg.body.token;
  const auth = { Authorization: `Bearer ${token}` };
  await request(app).post('/api/auth/otp/verify').set(auth).send({ code: reg.body.devOtp }).expect(200);
  await request(app)
    .post('/api/auth/identity')
    .set(auth)
    .send({ legalName: 'Test User', dob: '1990-01-01', idType: 'NIN', idNumber: `1000000${String(counter).padStart(4, '0')}`, address: '12 Wilberforce Street, Freetown' })
    .expect(200);
  const done = await request(app).post('/api/auth/pin').set(auth).send({ pin: '4829' }).expect(200);
  return { token, auth, pin: '4829', phone, user: done.body.user };
}

const fund = async (accountNumber, amountLe, reference) => {
  const raw = JSON.stringify({ accountNumber, amount: amountLe, reference });
  const sig = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(raw).digest('hex');
  return request(app).post('/api/webhooks/funding').set('Content-Type', 'application/json').set('x-signature', sig).send(raw);
};

test('health and catalog are public', async () => {
  const h = await request(app).get('/api/health').expect(200);
  assert.equal(h.body.ok, true);
  const c = await request(app).get('/api/catalog').expect(200);
  assert.ok(c.body.banks.length > 0);
  assert.equal(c.body.fees.transfer, 1);
});

test('protected routes need a token', async () => {
  await request(app).get('/api/me').expect(401);
  await request(app).get('/api/transactions').expect(401);
});

test('onboarding: sign up, verify, identity and PIN end with a usable account', async () => {
  const u = await onboard();
  assert.equal(u.user.onboardingStep, 'done');
  assert.equal(u.user.status, 'active');
  assert.equal(u.user.balance, 0);
  assert.match(u.user.accountNumber, /^\d{10}$/);
  const me = await request(app).get('/api/me').set(u.auth).expect(200);
  assert.equal(me.body.user.id, u.user.id);
  const dup = await request(app).post('/api/auth/register').send({ firstName: 'A', lastName: 'B', email: 'other@example.com', phone: u.phone, password: 'Strong#1234' });
  assert.equal(dup.status, 409);
});

test('login: wrong password is a generic 401, right password works, 5 failures lock the account', async () => {
  const u = await onboard();
  const email = `t${counter}@example.com`;
  const bad = await request(app).post('/api/auth/login').send({ identifier: email, password: 'Wrong#1234' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.code, 'INVALID_CREDENTIALS');
  await request(app).post('/api/auth/login').send({ identifier: u.phone, password: 'Strong#1234' }).expect(200);
  for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ identifier: email, password: 'Wrong#1234' });
  const locked = await request(app).post('/api/auth/login').send({ identifier: email, password: 'Strong#1234' });
  assert.equal(locked.status, 423);
});

test('money: webhook funding credits once, even when the partner retries', async () => {
  const u = await onboard();
  const ref = `PARTNER-${Date.now()}`;
  const a = await fund(u.user.accountNumber, 5000, ref);
  assert.equal(a.status, 200);
  const b = await fund(u.user.accountNumber, 5000, ref);
  assert.equal(b.body.duplicate, true);
  const w = await request(app).get('/api/wallet').set(u.auth).expect(200);
  assert.equal(w.body.balance, 5000);
  const bad = await request(app).post('/api/webhooks/funding').set('x-signature', 'deadbeef').send({ accountNumber: u.user.accountNumber, amount: 10, reference: 'FORGED-1' });
  assert.equal(bad.status, 401);
});

test('money: airtime debits, insufficient funds is 402, wrong PIN counts and locks', async () => {
  const u = await onboard();
  await fund(u.user.accountNumber, 100, `F-${Date.now()}-a`);
  const ok = await request(app).post('/api/payments/airtime').set(u.auth).send({ network: 'Orange', phone: '076123456', amount: 40, pin: u.pin }).expect(200);
  assert.equal(ok.body.balance, 60);
  assert.equal(ok.body.transaction.amount, -40);
  assert.equal(ok.body.transaction.status, 'Successful');
  const poor = await request(app).post('/api/payments/airtime').set(u.auth).send({ network: 'Orange', phone: '076123456', amount: 500, pin: u.pin });
  assert.equal(poor.status, 402);
  const w = await request(app).get('/api/wallet').set(u.auth);
  assert.equal(w.body.balance, 60, 'a refused payment must not change the balance');
  for (let i = 0; i < 4; i++) {
    const r = await request(app).post('/api/payments/airtime').set(u.auth).send({ network: 'Orange', phone: '076123456', amount: 1, pin: '1357' });
    assert.equal(r.body.code, 'BAD_PIN');
  }
  const locked = await request(app).post('/api/payments/airtime').set(u.auth).send({ network: 'Orange', phone: '076123456', amount: 1, pin: '1357' });
  assert.equal(locked.body.code, 'PIN_LOCKED');
  const stillLocked = await request(app).post('/api/payments/airtime').set(u.auth).send({ network: 'Orange', phone: '076123456', amount: 1, pin: u.pin });
  assert.equal(stillLocked.body.code, 'PIN_LOCKED');
});

test('money: the same Idempotency-Key never charges twice', async () => {
  const u = await onboard();
  await fund(u.user.accountNumber, 100, `F-${Date.now()}-b`);
  const send = () =>
    request(app).post('/api/payments/airtime').set(u.auth).set('Idempotency-Key', 'key-airtime-0001').send({ network: 'Orange', phone: '076123456', amount: 30, pin: u.pin });
  const a = await send();
  const b = await send();
  assert.equal(a.body.transaction.id, b.body.transaction.id);
  assert.equal((await request(app).get('/api/wallet').set(u.auth)).body.balance, 70);
  const other = await request(app).post('/api/payments/airtime').set(u.auth).set('Idempotency-Key', 'key-airtime-0001').send({ network: 'Orange', phone: '076123456', amount: 31, pin: u.pin });
  assert.equal(other.status, 409);
});

test('money: concurrent payments can never overdraw the wallet', async () => {
  const u = await onboard();
  await fund(u.user.accountNumber, 100, `F-${Date.now()}-c`);
  const results = await Promise.all(
    Array.from({ length: 12 }, () => request(app).post('/api/payments/airtime').set(u.auth).send({ network: 'Orange', phone: '076123456', amount: 30, pin: u.pin })),
  );
  const ok = results.filter((r) => r.status === 200).length;
  assert.equal(ok, 3, 'only 3 x Le 30 fit in Le 100');
  assert.equal((await request(app).get('/api/wallet').set(u.auth)).body.balance, 10);
  const row = await User.findOne({ accountNumber: u.user.accountNumber });
  assert.ok(row.balanceMinor >= 0);
});

test('money: a failed provider call refunds the customer and shows a reversal', async () => {
  const u = await onboard();
  await fund(u.user.accountNumber, 100, `F-${Date.now()}-d`);
  // Sandbox: numbers ending in 0000 are declined by the network.
  const r = await request(app).post('/api/payments/airtime').set(u.auth).send({ network: 'Orange', phone: '076120000', amount: 20, pin: u.pin });
  assert.equal(r.status, 502);
  assert.equal((await request(app).get('/api/wallet').set(u.auth)).body.balance, 100);
  const rows = await Txn.find({ user: u.user.id }).lean();
  assert.ok(rows.some((t) => t.status === 'Failed'));
  assert.ok(rows.some((t) => t.isReversal));
});

test('money: user to user transfer moves money atomically and rejects sending to yourself', async () => {
  const a = await onboard();
  const b = await onboard();
  await fund(a.user.accountNumber, 500, `F-${Date.now()}-e`);
  const ok = await request(app).post('/api/payments/transfer/user').set(a.auth).send({ accountNumber: b.user.accountNumber, amount: 120, note: 'Lunch', pin: a.pin }).expect(200);
  assert.equal(ok.body.balance, 380);
  assert.equal((await request(app).get('/api/wallet').set(b.auth)).body.balance, 120);
  const hist = await request(app).get('/api/transactions').set(b.auth).expect(200);
  assert.equal(hist.body.items[0].direction, 'credit');
  assert.match(hist.body.items[0].title, /^From /);
  const self = await request(app).post('/api/payments/transfer/user').set(a.auth).send({ accountNumber: a.user.accountNumber, amount: 5, pin: a.pin });
  assert.equal(self.status, 422);
});

test('people can only read their own transactions', async () => {
  const a = await onboard();
  const b = await onboard();
  await fund(a.user.accountNumber, 50, `F-${Date.now()}-f`);
  const list = await request(app).get('/api/transactions').set(a.auth).expect(200);
  const id = list.body.items[0].id;
  await request(app).get(`/api/transactions/${id}`).set(a.auth).expect(200);
  await request(app).get(`/api/transactions/${id}`).set(b.auth).expect(404);
});

test('admin routes are closed to customers', async () => {
  const u = await onboard();
  await request(app).get('/api/admin/stats').set(u.auth).expect(403);
  await request(app).patch(`/api/admin/users/${u.user.id}`).set(u.auth).send({ status: 'suspended' }).expect(403);
});

test('support: a customer can open a ticket and read the thread', async () => {
  const u = await onboard();
  const t = await request(app).post('/api/support/tickets').set(u.auth).send({ topic: 'Transfer', message: 'My transfer is late' }).expect(201);
  assert.equal(t.body.messages.length, 1);
  const list = await request(app).get('/api/support/tickets').set(u.auth).expect(200);
  assert.equal(list.body.items.length, 1);
  const chat = await request(app).get('/api/support/chat').set(u.auth).expect(200);
  assert.equal(chat.body.messages[0].from, 'agent');
});

test('forgot password: code, reset token, new password works and old one stops', async () => {
  const u = await onboard();
  const email = `t${counter}@example.com`;
  const f = await request(app).post('/api/auth/forgot').send({ identifier: email }).expect(200);
  const v = await request(app).post('/api/auth/forgot/verify').send({ identifier: email, code: f.body.devCode }).expect(200);
  await request(app).post('/api/auth/reset').send({ resetToken: v.body.resetToken, password: 'Brand#New5678' }).expect(200);
  await request(app).post('/api/auth/login').send({ identifier: email, password: 'Brand#New5678' }).expect(200);
  await request(app).post('/api/auth/login').send({ identifier: email, password: 'Strong#1234' }).expect(401);
  await request(app).get('/api/me').set(u.auth).expect(401); // old session is signed out
  await request(app).post('/api/auth/reset').send({ resetToken: v.body.resetToken, password: 'Another#9999' }).expect(422); // single use
  const unknown = await request(app).post('/api/auth/forgot').send({ identifier: 'nobody@example.com' });
  assert.equal(unknown.status, 200, 'no account enumeration');
});
