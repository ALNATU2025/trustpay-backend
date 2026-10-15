'use strict';
// yarn probe : checks where a payment POST can stall (database, local server, public URL).
const mongoose = require('mongoose');
const env = require('../config/env');
const { Idempotency } = require('../models');

const time = async (label, fn) => {
  const t = Date.now();
  try {
    const out = await Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error('no answer in 15s')), 15000))]);
    console.log(`${label}: ${out} (${Date.now() - t} ms)`);
  } catch (e) {
    console.log(`${label}: FAILED ${e.message} (${Date.now() - t} ms)`);
  }
};

const call = (base, method, path, { key = true, body = '{"provider":"Orange Money","number":"76123456","amount":10}' } = {}) => async () => {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = 'probe-key-12345678';
  const res = await fetch(`${base}${path}`, { method, headers, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(6000) });
  return `HTTP ${res.status}`;
};

(async () => {
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 15000 });
  await time('database write (idempotency key)', async () => {
    const user = new mongoose.Types.ObjectId();
    await Idempotency.create({ user, key: 'probe-key-12345678', route: 'probe', requestHash: 'x' });
    await Idempotency.deleteOne({ user, key: 'probe-key-12345678' });
    return 'ok';
  });
  const local = `http://127.0.0.1:${env.port}`;
  await time('A POST /payments/funding/momo-code (with key)   ', call(local, 'POST', '/api/payments/funding/momo-code'));
  await time('B same, without Idempotency-Key                 ', call(local, 'POST', '/api/payments/funding/momo-code', { key: false }));
  await time('C same, empty body {}                           ', call(local, 'POST', '/api/payments/funding/momo-code', { body: '{}' }));
  await time('D GET /payments/anything                        ', call(local, 'GET', '/api/payments/anything'));
  await time('E POST /lookup/bank (with key)                  ', call(local, 'POST', '/api/lookup/bank'));
  await time('F POST /auth/login (with key, bad body)         ', call(local, 'POST', '/api/auth/login', { body: '{}' }));
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
