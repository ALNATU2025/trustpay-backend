'use strict';
/**
 * npm run smoke
 * End-to-end check of a RUNNING server (local or Render).
 *   BASE_URL=https://trustpay-backend.onrender.com npm run smoke
 * The server must have OTP_DEBUG=true (never in production) so the sign-up code is returned.
 * It creates one throw-away test user.
 */
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const API = `${BASE}/api`;

async function call(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

let failed = 0;
const step = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` - ${extra}` : ''}`);
};

(async () => {
  const health = await call('GET', '/health');
  step('health', health.status === 200 && health.json.ok === true);

  const cat = await call('GET', '/catalog');
  step('catalog', cat.status === 200 && Array.isArray(cat.json.banks) && cat.json.banks.length > 0);

  const n = String(Math.floor(10000000 + Math.random() * 89999999));
  const phone = `+232${n}`;
  const email = `smoke.${Date.now()}@example.com`;
  const password = 'Smoke#Test1234';
  const reg = await call('POST', '/auth/register', { firstName: 'Smoke', lastName: 'Test', email, phone, password });
  step('register', reg.status === 201 && !!reg.json.token);
  const token = reg.json.token;

  if (!reg.json.devOtp) {
    step('devOtp present (needs OTP_DEBUG=true on the server)', false);
  } else {
    const v = await call('POST', '/auth/otp/verify', { code: reg.json.devOtp }, token);
    step('verify phone', v.status === 200 && v.json.user.onboardingStep === 'identity');
    const id = await call('POST', '/auth/identity', { legalName: 'Smoke Test', dob: '1990-01-01', idType: 'NIN', idNumber: `S${n}`, address: '1 Test Street, Freetown' }, token);
    step('identity', id.status === 200 && id.json.user.onboardingStep === 'pin', id.json.message || '');
    const pin = await call('POST', '/auth/pin', { pin: '4829' }, token);
    step('create pin', pin.status === 200 && pin.json.user.onboardingStep === 'done', pin.json.message || '');
  }

  const login = await call('POST', '/auth/login', { identifier: email, password });
  step('login', login.status === 200 && !!login.json.token);
  const me = await call('GET', '/me', null, login.json.token);
  step('me', me.status === 200 && me.json.user.email === email);
  const wallet = await call('GET', '/wallet', null, login.json.token);
  step('wallet starts at 0', wallet.status === 200 && wallet.json.balance === 0);
  const pay = await call('POST', '/payments/airtime', { network: 'Orange', phone: '076123456', amount: 5, pin: '4829' }, login.json.token);
  step('airtime with empty wallet is refused (402)', pay.status === 402, pay.json.message || '');
  const noAuth = await call('GET', '/me');
  step('protected route without a token is 401', noAuth.status === 401);

  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
