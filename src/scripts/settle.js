'use strict';
/**
 * npm run settle   (schedule daily at 16:00 as a Render Cron Job)
 * Pays merchants for POS payments received so far. Safe to run twice or after a crash: credits are
 * keyed by the settlement, so money is never paid out twice.
 */
const env = require('../config/env');
const { connect, disconnect } = require('../db');
const { PosPayment, Settlement } = require('../models');
const { bpsOf } = require('../utils/money');
const { CODES, createWithReference } = require('../utils/references');
const { applyExternalCredit } = require('../services/wallet');

async function finish(settlement) {
  const agg = await PosPayment.aggregate([
    { $match: { settlement: settlement._id } },
    { $group: { _id: null, gross: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
  ]);
  const gross = agg[0] ? agg[0].gross : 0;
  const count = agg[0] ? agg[0].count : 0;
  const fee = bpsOf(gross, env.settlementFeeBps);
  const net = gross - fee;
  if (count === 0 || net <= 0) {
    await Settlement.deleteOne({ _id: settlement._id });
    return null;
  }
  await applyExternalCredit({
    userId: settlement.owner,
    kind: 'pos',
    subtype: 'pos_settlement',
    code: CODES.settlement,
    amountMinor: net,
    feeMinor: fee,
    details: { count, grossMinor: gross, feeMinor: fee, reference: settlement.reference },
    externalRef: `settle:${settlement._id}`,
  });
  await Settlement.updateOne({ _id: settlement._id }, { $set: { grossMinor: gross, feeMinor: fee, netMinor: net, count, status: 'Paid', settledAt: new Date() } });
  return { gross, fee, net, count };
}

async function main() {
  env.assertValid();
  await connect();
  const cutoff = new Date();
  let paid = 0;

  // 1. Resume anything a crashed run left half done.
  for (const s of await Settlement.find({ status: 'Processing' })) {
    if (await finish(s)) paid++;
  }

  // 2. Start new settlements, one per merchant with unsettled payments.
  const owners = await PosPayment.distinct('owner', { settled: false, settlement: null, createdAt: { $lte: cutoff } });
  for (const owner of owners) {
    const s = await createWithReference(Settlement, CODES.settlement, (reference) => ({
      owner,
      reference,
      grossMinor: 0,
      feeMinor: 0,
      netMinor: 0,
      count: 0,
      scheduledFor: cutoff,
    }));
    // Claim the payments first, then pay: a crash between the two is picked up by step 1 next run.
    await PosPayment.updateMany({ owner, settled: false, settlement: null, createdAt: { $lte: cutoff } }, { $set: { settlement: s._id, settled: true } });
    if (await finish(s)) paid++;
  }
  console.log(`Settlement run finished: ${paid} merchant(s) paid.`);
  await disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
