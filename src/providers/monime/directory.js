'use strict';
/**
 * Maps the names shown in the app ("Orange Money", "Guaranty Trust Bank") to Monime provider ids
 * (m17, slb004, ...). The lists come from GET /v1/banks and /v1/momos and are cached for an hour.
 */
const env = require('../../config/env');
const client = require('./client');
const { ProviderError } = require('../errors');

const TTL = 60 * 60 * 1000;
const cache = { bank: null, momo: null };

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\b(sierra leone|sl|limited|ltd|plc|bank|banking|corporation|corp|the|of|money|mobile|wallet)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');

async function listAll(kind) {
  const path = kind === 'bank' ? '/v1/banks' : '/v1/momos';
  const items = await client.read(path, { country: env.monime.country, limit: 50 });
  return Array.isArray(items) ? items : [];
}

async function load(kind, force) {
  const hit = cache[kind];
  if (!force && hit && Date.now() - hit.at < TTL) return hit.items;
  const items = (await listAll(kind)).filter((p) => !p.status || p.status.active !== false);
  cache[kind] = { at: Date.now(), items };
  return items;
}

/** Returns the Monime provider for an app-facing name, or throws a 'failed' ProviderError. */
async function resolve(kind, name) {
  let items;
  try {
    items = await load(kind);
  } catch (err) {
    throw new ProviderError('We could not reach the payment provider. Please try again.', { outcome: 'failed' });
  }
  const want = norm(name);
  const found =
    items.find((p) => p.providerId === name) ||
    items.find((p) => norm(p.name) === want) ||
    items.find((p) => want && (norm(p.name).includes(want) || want.includes(norm(p.name))));
  if (!found) {
    throw new ProviderError(`${name} is not supported for payments yet.`, { outcome: 'failed' });
  }
  return found;
}

const clear = () => {
  cache.bank = null;
  cache.momo = null;
};

module.exports = { load, resolve, norm, clear };
