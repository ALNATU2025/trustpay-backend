'use strict';
/**
 * npm run monime:sync [-- --apply]
 * Lists the banks and mobile-money wallets Monime supports in your country and (with --apply)
 * writes those names into the Config document, so the app only offers providers that really work.
 */
const env = require('../config/env');
const { connect, disconnect } = require('../db');
const directory = require('../providers/monime/directory');
const { Config } = require('../models');

(async () => {
  const banks = (await directory.load('bank', true)).filter((b) => !b.featureSet || !b.featureSet.payout || b.featureSet.payout.canPayTo !== false);
  const momos = (await directory.load('momo', true)).filter((m) => !/\b(agent|merchant)\b/i.test(m.name || '')).filter((m) => !m.featureSet || !m.featureSet.payout || m.featureSet.payout.canPayTo !== false);
  console.log('Banks:');
  banks.forEach((b) => console.log(`  ${b.providerId}  ${b.name}`));
  console.log('Mobile money:');
  momos.forEach((m) => console.log(`  ${m.providerId}  ${m.name}`));
  if (process.argv.includes('--apply')) {
    await connect();
    await Config.updateOne({}, { $set: { banks: banks.map((b) => b.name), mobileMoney: momos.map((m) => m.name) } });
    console.log('Config updated.');
    await disconnect();
  } else {
    console.log('\nRun with --apply to save these names into the app catalog.');
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
