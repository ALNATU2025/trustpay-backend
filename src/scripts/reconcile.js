'use strict';
/**
 * npm run reconcile   (run every few minutes as a Render Cron Job)
 * Finishes payments whose webhook never arrived: asks Monime for the real status of every Pending
 * payout / checkout top-up and refunds, credits or confirms accordingly. Safe to run repeatedly.
 */
const env = require('../config/env');
const { connect, disconnect } = require('../db');
const { reconcilePending } = require('../services/monime');

(async () => {
  if (env.providerMode !== 'live') {
    console.log('PROVIDER_MODE is not live: nothing to reconcile.');
    return;
  }
  await connect();
  const r = await reconcilePending();
  console.log(`Reconcile: checked ${r.checked}, settled ${r.settled}, errors ${r.errors}`);
  await disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
