'use strict';
/**
 * npm run load-test
 * Proves concurrent payments can never overdraw a wallet. Run against STAGING with a funded test user:
 *   BASE_URL=... TEST_LOGIN=you@example.com TEST_PASSWORD=... TEST_PIN=1234 PARALLEL=30 AMOUNT=10 npm run load-test
 * It fires PARALLEL airtime purchases at once, then checks balance_before - successes*AMOUNT === balance_after.
 */
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const API = `${BASE}/api`;
const { TEST_LOGIN, TEST_PASSWORD, TEST_PIN } = process.env;
const PARALLEL = Number(process.env.PARALLEL || 30);
const AMOUNT = Number(process.env.AMOUNT || 10);

async function call(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

(async () => {
  if (!TEST_LOGIN || !TEST_PASSWORD || !TEST_PIN) throw new Error('Set TEST_LOGIN, TEST_PASSWORD and TEST_PIN.');
  const login = await call('POST', '/auth/login', { identifier: TEST_LOGIN, password: TEST_PASSWORD });
  if (!login.json.token) throw new Error(`Login failed: ${login.json.message}`);
  const token = login.json.token;
  const before = (await call('GET', '/wallet', null, token)).json.balance;
  console.log(`Balance before: ${before}`);

  const results = await Promise.all(
    Array.from({ length: PARALLEL }, () =>
      call('POST', '/payments/airtime', { network: 'Orange', phone: '076123456', amount: AMOUNT, pin: TEST_PIN }, token),
    ),
  );
  const ok = results.filter((r) => r.status === 200 && r.json.transaction && r.json.transaction.status === 'Successful').length;
  const refused = results.filter((r) => r.status === 402).length;
  const other = results.length - ok - refused;
  const after = (await call('GET', '/wallet', null, token)).json.balance;
  const expected = Math.round((before - ok * AMOUNT) * 100) / 100;
  console.log(`Requests: ${PARALLEL}  ok: ${ok}  insufficient: ${refused}  other: ${other}`);
  console.log(`Balance after: ${after}  expected: ${expected}`);
  if (after < 0 || Math.abs(after - expected) > 0.001) {
    console.error('FAIL: balance does not match the successful payments.');
    process.exit(1);
  }
  console.log('PASS: no overdraw and the ledger matches.');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
