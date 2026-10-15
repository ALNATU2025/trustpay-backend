'use strict';
const { fromMinor } = require('../utils/money');

const named = (list) => list.map((x) => ({ name: x.name, subtitle: x.subtitle }));
const pkgs = (list) => list.map((p) => ({ id: p.id, name: p.name, detail: p.detail, price: fromMinor(p.priceMinor) }));

function presentCatalog(cfg) {
  const f = cfg.feesMinor;
  return {
    banks: cfg.banks,
    mobileMoney: cfg.mobileMoney,
    networks: cfg.networks,
    electricity: named(cfg.electricity),
    tv: named(cfg.tv),
    internet: named(cfg.internet),
    dataPlans: cfg.dataPlans.map((p) => ({ id: p.id, size: p.size, days: p.days, price: fromMinor(p.priceMinor) })),
    tvPackages: pkgs(cfg.tvPackages),
    internetPackages: pkgs(cfg.internetPackages),
    fees: {
      transfer: fromMinor(f.transfer),
      mobileMoneySend: fromMinor(f.mobileMoneySend),
      bill: fromMinor(f.bill),
      cardIssuance: fromMinor(f.cardIssuance),
      physicalCard: fromMinor(f.physicalCard),
      terminalDeposit: fromMinor(f.terminalDeposit),
      terminalDelivery: fromMinor(f.terminalDelivery),
      cardFundingPercent: (cfg.feeRatesBps.cardFunding || 0) / 100,
    },
    terminal: cfg.terminal,
    topics: cfg.topics,
    support: cfg.support,
    // 'checkout' = top-ups happen on the provider's hosted page (card, bank, mobile money); 'direct' = sandbox, instant.
    features: { fundingMode: require('../config/env').providerMode === 'live' ? 'checkout' : 'direct' },
  };
}

module.exports = { presentCatalog };
