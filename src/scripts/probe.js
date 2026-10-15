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

const post = (base) => async () => {
  const res = await fetch(`${base}/api/payments/funding/momo-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'probe-key-12345678' },
    body: JSON.stringify({ provider: 'Orange Money', number: '76123456', amount: 10 }),
  });
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
  await time(`POST to this server (localhost:${env.port}), expect HTTP 401`, post(`http://127.0.0.1:${env.port}`));
  if (env.publicUrl) await time(`POST to public URL (${env.publicUrl}), expect HTTP 401`, post(env.publicUrl));
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
