'use strict';
const { Config } = require('../models');
const defaults = require('../config/defaults');

let cache = null;
let cachedAt = 0;
const TTL_MS = 30 * 1000;

const LIST_KEYS = ['banks', 'mobileMoney', 'networks', 'electricity', 'tv', 'internet', 'dataPlans', 'tvPackages', 'internetPackages', 'topics'];

/** Seeded Config document merged over the in-code defaults (so a fresh deploy works before seeding). */
async function getConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  let doc = null;
  try {
    doc = await Config.findOne({ key: 'app' }).lean();
  } catch (_) {
    if (cache) return cache; // keep serving the last good copy if the DB blips
    throw _;
  }
  const cfg = { ...defaults };
  if (doc) {
    for (const k of LIST_KEYS) if (Array.isArray(doc[k]) && doc[k].length) cfg[k] = doc[k];
    cfg.feesMinor = { ...defaults.feesMinor, ...(doc.feesMinor || {}) };
    cfg.feeRatesBps = { ...defaults.feeRatesBps, ...(doc.feeRatesBps || {}) };
    if (doc.terminal && (doc.terminal.categories || []).length) cfg.terminal = { ...defaults.terminal, ...doc.terminal };
    if (doc.support && doc.support.phone) cfg.support = { ...defaults.support, ...doc.support };
  }
  // Render environment variables win over seeded values, so support details can change without a re-seed.
  const sp = process.env;
  cfg.support = {
    phone: sp.SUPPORT_PHONE || cfg.support.phone,
    email: sp.SUPPORT_EMAIL || cfg.support.email,
    hours: sp.SUPPORT_HOURS || cfg.support.hours,
  };
  cache = cfg;
  cachedAt = Date.now();
  return cfg;
}

const clearCache = () => {
  cache = null;
};

const { presentCatalog } = require('./catalogPresenter');

module.exports = { getConfig, clearCache, presentCatalog };
