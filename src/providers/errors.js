'use strict';

/**
 * ProviderError: the partner rejected / could not complete the request.
 *   outcome 'failed'  -> nothing happened on the rail; the wallet debit is refunded.
 *   outcome 'unknown' -> the call timed out or the result is ambiguous; the transaction stays
 *                        Pending and is NOT refunded automatically (reconcile with the partner).
 */
class ProviderError extends Error {
  constructor(message, { outcome = 'failed', code = 'PROVIDER_ERROR' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.outcome = outcome;
    this.code = code;
  }
}

/** Thrown by every `live` adapter until you wire the real partner API in. */
class NotConfiguredError extends Error {
  constructor(adapter, method, partner) {
    super(`Live provider "${adapter}.${method}" is not configured. Implement it against ${partner}, or set PROVIDER_MODE=sandbox.`);
    this.name = 'NotConfiguredError';
    this.adapter = adapter;
    this.code = 'PROVIDER_NOT_CONFIGURED';
  }
}

/** Builds a `live` adapter whose every method throws NotConfiguredError. */
function notConfigured(adapter, partner, methods) {
  const out = {};
  for (const m of methods) {
    out[m] = async () => {
      throw new NotConfiguredError(adapter, m, partner);
    };
  }
  return out;
}

module.exports = { ProviderError, NotConfiguredError, notConfigured };
