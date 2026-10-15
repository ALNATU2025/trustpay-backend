'use strict';
const client = require('./client');
const { MonimeHttpError } = client;
const { ProviderError } = require('../errors');

/**
 * Account-holder name from the provider (GET /v1/provider-kyc/{providerId}?accountId=...).
 * Returns the name, or null when the provider cannot verify that account.
 * Not every provider supports name checks; for those we return `undefined` ("cannot verify").
 */
async function holderName(providerId, accountId) {
  try {
    const r = await client.read(`/v1/provider-kyc/${encodeURIComponent(providerId)}`, { accountId });
    const a = r && r.account;
    const name = a && (a.holderName || a.name);
    return name ? String(name) : null;
  } catch (err) {
    if (err instanceof MonimeHttpError) {
      if (err.status === 404) return null;
      if (err.status === 400 || err.status === 422 || err.status === 501) return undefined;
    }
    throw new ProviderError('We could not verify that account right now. Please try again.', { outcome: 'failed' });
  }
}

module.exports = { holderName };
