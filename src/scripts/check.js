'use strict';
/**
 * npm run check
 * Pre-flight and reconciliation report. Read only. Exit code 1 if something needs attention.
 */
const env = require('../config/env');
const { connect, disconnect } = require('../db');
const { Txn, User } = require('../models');

async function main() {
  let bad = false;
  const say = (ok, msg) => {
    if (!ok) bad = true;
    console.log(`${ok ? 'OK  ' : 'WARN'} ${msg}`);
  };

  try {
    env.assertValid();
    say(true, 'Environment is valid');
  } catch (e) {
    say(false, e.message);
  }
  say(env.providerMode === 'live' || !env.isProd, `PROVIDER_MODE=${env.providerMode}${env.isProd && env.providerMode !== 'live' ? ' in production: no real money or SMS' : ''}`);
  for (const w of env.warnings) say(false, w);

  await connect();
  say(true, 'MongoDB reachable');

  const stuck = await Txn.countDocuments({ status: 'Pending', createdAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } });
  say(stuck === 0, `${stuck} transaction(s) pending for more than 10 minutes (check needsReview)`);
  const review = await Txn.countDocuments({ needsReview: true });
  say(review === 0, `${review} transaction(s) flagged needsReview (reconcile with the provider)`);
  const orphan = await Txn.countDocuments({ status: 'Pending', debited: false, direction: 'debit', createdAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } });
  say(orphan === 0, `${orphan} debit(s) created but never charged (safe to delete)`);
  const admins = await User.countDocuments({ role: 'admin' });
  say(admins > 0, `${admins} admin account(s)`);

  // Ledger check: balances are never negative.
  const negative = await User.countDocuments({ balanceMinor: { $lt: 0 } });
  say(negative === 0, `${negative} account(s) with a negative balance`);

  await disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
