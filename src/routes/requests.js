'use strict';
/**
 * Money requests and payment links.
 *   POST /requests               ask a TrustPay customer (accountNumber or phone) for money, or make an open link
 *   GET  /requests?box=...       incoming (asked of me) / outgoing (I asked)
 *   GET  /requests/code/:code    look up a link by its code (anyone signed in)
 *   POST /requests/:id/pay       pay it (PIN)
 *   POST /requests/:id/decline   payer says no
 *   POST /requests/:id/cancel    requester withdraws it
 */
const express = require('express');
const { MoneyRequest, User } = require('../models');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth, requireOnboarded } = require('../middleware/auth');
const limits = require('../middleware/limits');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { CODES, isDuplicateKey } = require('../utils/references');
const { randomDigits } = require('../utils/crypto');
const { fromMinor, formatLe } = require('../utils/money');
const { verifyPin } = require('../services/security');
const { assertCanTransact, fullName } = require('../services/wallet');
const { assertCanReceive } = require('../services/tiers');
const { idempotent } = require('../services/idempotency');
const { moveMoney } = require('../services/p2p');
const { present } = require('../services/presenter');
const notify = require('../services/notify');
const env = require('../config/env');

const router = express.Router();
router.use(requireAuth, requireOnboarded);

const TTL_DAYS = 7;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[Number(randomDigits(2)) % ALPHABET.length]).join('');
const linkOf = (code) => `${env.publicUrl || ''}/api/pay/request/${code}`;

function presentRequest(r, me, people) {
  const mine = String(r.requester) === String(me);
  const requester = people[String(r.requester)];
  const payer = r.payer ? people[String(r.payer)] : null;
  const expired = r.status === 'pending' && r.expiresAt < new Date();
  return {
    id: String(r._id),
    code: r.code,
    link: linkOf(r.code),
    amount: fromMinor(r.amountMinor),
    note: r.note || '',
    status: expired ? 'expired' : r.status,
    direction: mine ? 'outgoing' : 'incoming',
    requesterName: requester ? fullName(requester) : 'TrustPay customer',
    payerName: payer ? fullName(payer) : null,
    open: !r.payer,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    paidAt: r.paidAt ? r.paidAt.toISOString() : null,
  };
}

async function peopleFor(rows) {
  const ids = [...new Set(rows.flatMap((r) => [r.requester, r.payer, r.paidBy]).filter(Boolean).map(String))];
  const users = await User.find({ _id: { $in: ids } }).select('firstName lastName accountNumber').lean();
  return Object.fromEntries(users.map((u) => [String(u._id), u]));
}

router.post(
  '/',
  limits.payment,
  validate(S.requestCreate),
  asyncHandler(async (req, res) => {
    assertCanTransact(req.user);
    const b = req.body;
    let payer = null;
    if (b.accountNumber || b.phone) {
      payer = await User.findOne(b.accountNumber ? { accountNumber: b.accountNumber } : { phone: b.phone }).select('firstName lastName accountNumber status onboardingStep');
      if (!payer || payer.status !== 'active' || payer.onboardingStep !== 'done' || String(payer._id) === String(req.user._id)) {
        throw E.validation('We could not find a TrustPay account for that number.');
      }
    }
    await assertCanReceive(req.user._id, b.amount);
    let doc;
    for (let i = 0; i < 6 && !doc; i++) {
      try {
        doc = await MoneyRequest.create({
          requester: req.user._id,
          payer: payer ? payer._id : undefined,
          amountMinor: b.amount,
          note: b.note || '',
          code: newCode(),
          expiresAt: new Date(Date.now() + TTL_DAYS * 86400000),
        });
      } catch (err) {
        if (!isDuplicateKey(err, 'code')) throw err;
      }
    }
    if (!doc) throw E.unavailable('Could not create the request. Please try again.');
    if (payer) {
      notify.notifyUser(payer._id, {
        type: 'request',
        title: 'Money request',
        body: `${fullName(req.user)} is asking you for ${formatLe(b.amount)}${b.note ? ` · ${b.note}` : ''}.`,
        data: { requestId: String(doc._id) },
      });
    }
    const people = await peopleFor([doc]);
    res.status(201).json({ request: presentRequest(doc, req.user._id, people) });
  }),
);

router.get(
  '/',
  validate(S.requestList, 'query'),
  asyncHandler(async (req, res) => {
    const me = req.user._id;
    const box = req.query.box;
    const filter = box === 'incoming' ? { payer: me } : { requester: me };
    const rows = await MoneyRequest.find(filter).sort({ createdAt: -1 }).limit(60).lean();
    const people = await peopleFor(rows);
    res.json({ items: rows.map((r) => presentRequest(r, me, people)) });
  }),
);

router.get(
  '/code/:code',
  limits.lookup,
  asyncHandler(async (req, res) => {
    const r = await MoneyRequest.findOne({ code: String(req.params.code).toUpperCase().trim() }).lean();
    if (!r || (r.payer && String(r.payer) !== String(req.user._id) && String(r.requester) !== String(req.user._id))) {
      throw E.notFound('We could not find that payment request.');
    }
    const people = await peopleFor([r]);
    res.json({ request: presentRequest(r, req.user._id, people) });
  }),
);

router.post(
  '/:id/pay',
  limits.payment,
  validate(S.requestPay),
  asyncHandler(async (req, res) => {
    const out = await idempotent(req, `request.pay.${req.params.id}`, async () => {
      assertCanTransact(req.user);
      const r = await MoneyRequest.findById(req.params.id);
      if (!r) throw E.notFound('We could not find that payment request.');
      if (String(r.requester) === String(req.user._id)) throw E.validation('You cannot pay your own request.');
      if (r.payer && String(r.payer) !== String(req.user._id)) throw E.forbidden('This request was sent to someone else.');
      if (r.status !== 'pending') throw E.conflict(`This request is already ${r.status}.`, 'REQUEST_CLOSED');
      if (r.expiresAt < new Date()) throw E.conflict('This request has expired.', 'REQUEST_EXPIRED');
      const to = await User.findById(r.requester).select('firstName lastName accountNumber status onboardingStep');
      if (!to || to.status !== 'active') throw E.validation('The person who asked for this money cannot receive it right now.');
      await assertCanReceive(to._id, r.amountMinor, { self: false });
      await verifyPin(req.user._id, req.body.pin);

      // Claim it first so two taps (or two payers of an open link) can never both pay.
      const claimed = await MoneyRequest.findOneAndUpdate({ _id: r._id, status: 'pending' }, { $set: { status: 'paid', paidBy: req.user._id, paidAt: new Date() } }, { new: true });
      if (!claimed) throw E.conflict('This request was just paid or closed.', 'REQUEST_CLOSED');
      let result;
      try {
        result = await moveMoney({
          payer: req.user,
          payee: to,
          kind: 'transfer',
          code: CODES.request,
          outSubtype: 'request_pay_out',
          inSubtype: 'request_pay_in',
          amountMinor: r.amountMinor,
          outDetails: { accountName: fullName(to), accountNumber: to.accountNumber, note: r.note, requestCode: r.code },
          inDetails: { senderName: fullName(req.user), senderAccount: req.user.accountNumber, note: r.note, requestCode: r.code },
          notice: { title: 'Request paid', body: (amt) => `${fullName(req.user)} paid your request: ${amt}.` },
        });
      } catch (err) {
        await MoneyRequest.updateOne({ _id: r._id, paidBy: req.user._id }, { $set: { status: 'pending' }, $unset: { paidBy: 1, paidAt: 1 } }).catch(() => {});
        throw err;
      }
      await MoneyRequest.updateOne({ _id: r._id }, { $set: { paidReference: result.txn.reference } }).catch(() => {});
      return { status: 200, body: { transaction: present(result.txn), balance: fromMinor(result.balanceMinor) } };
    });
    res.status(out.status).json(out.body);
  }),
);

router.post(
  '/:id/decline',
  asyncHandler(async (req, res) => {
    const r = await MoneyRequest.findOneAndUpdate({ _id: req.params.id, payer: req.user._id, status: 'pending' }, { $set: { status: 'declined' } }, { new: true });
    if (!r) throw E.notFound('We could not find an open request to decline.');
    notify.notifyUser(r.requester, { type: 'request', title: 'Request declined', body: `${fullName(req.user)} declined your request for ${formatLe(r.amountMinor)}.` });
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const r = await MoneyRequest.findOneAndUpdate({ _id: req.params.id, requester: req.user._id, status: 'pending' }, { $set: { status: 'cancelled' } }, { new: true });
    if (!r) throw E.notFound('We could not find an open request to cancel.');
    res.json({ ok: true });
  }),
);

module.exports = router;
