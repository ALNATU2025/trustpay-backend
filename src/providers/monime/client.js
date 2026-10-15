'use strict';
/**
 * Minimal Monime REST client (https://docs.monime.io, version caph.2025-08-23).
 * Money is in minor units (SLE: 1 Le = 100), the same unit TrustPay stores, so no conversion is needed.
 *
 * Error mapping:
 *   - network error / timeout / 5xx        -> ProviderError outcome 'unknown'  (the call may have gone through)
 *   - 4xx on a *read*                      -> MonimeHttpError (callers decide)
 *   - 4xx on a *write*                     -> ProviderError outcome 'failed'   (Monime rejected it; nothing happened)
 */
const env = require('../../config/env');
const { ProviderError } = require('../errors');
const log = require('../../utils/log');

class MonimeHttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'MonimeHttpError';
    this.status = status;
    this.body = body;
  }
}

function headers(extra) {
  return {
    Authorization: `Bearer ${env.monime.token}`,
    'Monime-Space-Id': env.monime.spaceId,
    'Monime-Version': env.monime.version,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

/** Pulls a readable message out of a Monime error body. */
function messageOf(body, fallback) {
  const e = body && (body.error || body);
  const m = e && (e.message || (Array.isArray(body.messages) && body.messages[0]));
  return typeof m === 'string' && m ? m : fallback;
}

async function raw(method, path, { query, body, idempotencyKey } = {}) {
  if (!env.monime.token || !env.monime.spaceId) {
    throw new ProviderError('Payments are not configured yet.', { outcome: 'failed', code: 'PROVIDER_NOT_CONFIGURED' });
  }
  const url = new URL(env.monime.baseUrl + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), env.monime.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: headers(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 64) } : undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    log.info('Monime call', { method, path, status: res.status, ms: Date.now() - started });
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    if (!res.ok) throw new MonimeHttpError(res.status, messageOf(json, `Monime returned HTTP ${res.status}.`), json);
    return json;
  } catch (err) {
    if (err instanceof MonimeHttpError) throw err;
    const timedOut = err && err.name === 'AbortError';
    if (!(err instanceof MonimeHttpError)) log.warn('Monime call failed', { method, path, ms: Date.now() - started, reason: timedOut ? 'timeout' : err && err.message });
    throw Object.assign(new Error(timedOut ? 'Monime timed out.' : `Monime is unreachable: ${err && err.message}`), { network: true });
  } finally {
    clearTimeout(timer);
  }
}

/** Reads: returns `result`. Throws MonimeHttpError / network errors untouched. */
async function read(path, query) {
  const json = await raw('GET', path, { query });
  return json && json.result !== undefined ? json.result : json;
}

/** Writes: translates failures into ProviderError so payDebit/payCredit refund or hold correctly. */
async function write(method, path, body, idempotencyKey) {
  try {
    const json = await raw(method, path, { body, idempotencyKey });
    return json && json.result !== undefined ? json.result : json;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof MonimeHttpError) {
      log.warn('Monime rejected a request', { path, status: err.status, message: err.message });
      // 401/403 are OUR configuration problem: nothing happened, but do not show internals to the customer.
      if (err.status === 401 || err.status === 403) {
        throw new ProviderError('This service is temporarily unavailable.', { outcome: 'failed', code: 'PROVIDER_NOT_CONFIGURED' });
      }
      if (err.status === 409 || err.status >= 500) {
        // 409 = same idempotency key still running; 5xx = unknown. Do not refund automatically.
        throw new ProviderError('The provider did not confirm the request.', { outcome: 'unknown' });
      }
      throw new ProviderError(err.message, { outcome: 'failed' });
    }
    log.warn('Monime call outcome unknown', { path, message: err && err.message });
    throw new ProviderError('The provider did not respond.', { outcome: 'unknown' });
  }
}

module.exports = { read, write, MonimeHttpError };
