'use strict';
const express = require('express');
const env = require('../config/env');
const { User, Terminal, PosPayment } = require('../models');
const S = require('../validators/schemas');
const { formatIssue } = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { verifyHmac } = require('../utils/crypto');
const { CODES, isDuplicateKey } = require('../utils/references');
const { applyExternalCredit } = require('../services/wallet');
const log = require('../utils/log');
const monime = require('../services/monime');

const router = express.Router();

/** Every webhook must carry x-signature = HMAC-SHA256(rawBody, WEBHOOK_SECRET). */
function signed(req, res, next) {
  if (!verifyHmac(req.rawBody, req.get('x-signature'), env.webhookSecret)) {
    return next(E.unauthorized('Invalid signature.', 'BAD_SIGNATURE'));
  }
  return next();
}

function parse(schema) {
  return (req, res, next) => {
    const r = schema.safeParse(req.body);
    if (!r.success) return next(E.validation(formatIssue(r.error.issues[0])));
    req.body = r.data;
    return next();
  };
}

router.post(
  '/funding',
  signed,
  parse(S.webhookFunding),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const user = await User.findOne({ accountNumber: b.accountNumber }).select('_id status');
    if (!user) throw E.notFound('Unknown account number.', 'UNKNOWN_ACCOUNT');
    const out = await applyExternalCredit({
      userId: user._id,
      kind: 'funding',
      subtype: 'funding_bank',
      code: CODES.funding,
      amountMinor: b.amount,
      details: { sender: b.sender, partnerReference: b.reference },
      externalRef: `fund:${b.reference}`,
    });
    res.json({ ok: true, duplicate: out.duplicate, reference: out.txn.reference });
  }),
);

router.post(
  '/pos',
  signed,
  parse(S.webhookPos),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const terminal = await Terminal.findOne({ code: b.terminalCode });
    if (!terminal) throw E.notFound('Unknown terminal.', 'UNKNOWN_TERMINAL');
    if (terminal.status !== 'active') throw E.forbidden('This terminal is disabled.', 'TERMINAL_DISABLED');
    let duplicate = false;
    try {
      await PosPayment.create({
        terminal: terminal._id,
        terminalCode: terminal.code,
        owner: terminal.owner,
        amountMinor: b.amount,
        kind: b.kind,
        payer: b.payer,
        reference: b.reference,
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      duplicate = true; // the terminal retried: already recorded
    }
    const set = { lastSyncAt: new Date() };
    if (b.battery !== undefined) set.battery = b.battery;
    if (b.connection) set.connection = b.connection;
    await Terminal.updateOne({ _id: terminal._id }, { $set: set });
    if (!duplicate) log.info('POS payment recorded', { terminal: terminal.code });
    res.json({ ok: true, duplicate });
  }),
);

/**
 * Monime events (payout.completed / payout.failed / payment.completed / checkout_session.*).
 * Register this URL in the Monime dashboard or via POST /v1/webhooks:
 *   https://<service>.onrender.com/api/webhooks/monime
 * The handler re-reads the resource from Monime before touching any money (see services/monime.js),
 * so the body alone can never credit or refund anyone.
 */
router.post(
  '/monime',
  asyncHandler(async (req, res) => {
    if (env.providerMode !== 'live') return res.json({ ok: true, ignored: 'sandbox' });
    const sig = monime.checkSignature(req);
    if (sig === 'bad') throw E.unauthorized('Invalid signature.', 'BAD_SIGNATURE');
    if (sig === 'none' && env.monime.webhookSecret) log.warn('Monime webhook had no recognised signature header; verified by re-reading from Monime instead.');
    const result = await monime.processEvent(req.body);
    res.json({ ok: true, handled: !!result.handled });
  }),
);

module.exports = router;
