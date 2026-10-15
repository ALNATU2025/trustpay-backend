'use strict';
/**
 * Optional phone push through Firebase Cloud Messaging (HTTP v1).
 * Needs FCM_SERVICE_ACCOUNT_JSON (Firebase console > Project settings > Service accounts > Generate key).
 * Without it every call is a quiet no-op and customers still see notifications in the app's inbox.
 */
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const log = require('../utils/log');

let account = null;
let parsed = false;
let cached = { token: null, exp: 0 };

function sa() {
  if (parsed) return account;
  parsed = true;
  if (!env.fcmServiceAccountJson) return null;
  try {
    const a = JSON.parse(env.fcmServiceAccountJson);
    if (a.client_email && a.private_key && a.project_id) account = a;
  } catch (e) {
    log.warn('FCM_SERVICE_ACCOUNT_JSON is not valid JSON; push is off');
  }
  return account;
}

const enabled = () => !!sa();

async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  const a = sa();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    a.private_key,
    { algorithm: 'RS256' },
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`FCM auth failed (${res.status})`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

/** Sends to each token. Returns the tokens FCM says are dead so the caller can forget them. */
async function send(tokens, { title, body, data = {} }) {
  if (!enabled() || !tokens || !tokens.length) return [];
  const dead = [];
  try {
    const token = await accessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${sa().project_id}/messages:send`;
    const strData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
    for (let i = 0; i < tokens.length; i += 10) {
      await Promise.all(
        tokens.slice(i, i + 10).map(async (t) => {
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: { token: t, notification: { title, body }, data: strData, android: { priority: 'HIGH' } } }),
            });
            if (res.status === 404 || res.status === 400) dead.push(t);
            else if (!res.ok) log.warn('FCM send failed', { status: res.status });
          } catch (e) {
            log.warn('FCM send error', { message: e && e.message });
          }
        }),
      );
    }
  } catch (e) {
    log.warn('Push skipped', { message: e && e.message });
  }
  return dead;
}

module.exports = { enabled, send };
