'use strict';
const express = require('express');
const providers = require('../providers');
const { Card } = require('../models');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth, requireOnboarded } = require('../middleware/auth');
const limits = require('../middleware/limits');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { CODES, isDuplicateKey } = require('../utils/references');
const { fromMinor } = require('../utils/money');
const { encrypt, decrypt } = require('../utils/crypto');
const { ProviderError } = require('../providers/errors');
const { getConfig } = require('../services/catalog');
const { verifyPin } = require('../services/security');
const { payDebit, assertCanTransact } = require('../services/wallet');
const { idempotent } = require('../services/idempotency');
const { present, presentCard, iso } = require('../services/presenter');
const log = require('../utils/log');

const router = express.Router();
router.use(requireAuth, requireOnboarded);

const holderOf = (u) => `${u.firstName} ${u.lastName}`.trim().toUpperCase();

function money(route, run) {
  return asyncHandler(async (req, res) => {
    const out = await idempotent(req, route, async () => {
      assertCanTransact(req.user);
      return { status: 200, body: await run(req) };
    });
    res.status(out.status).json(out.body);
  });
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const cards = await Card.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json({
      virtual: cards.filter((c) => c.type === 'virtual').map(presentCard)[0] || null,
      physical: cards.filter((c) => c.type === 'physical').map(presentCard),
    });
  }),
);

router.post(
  '/virtual',
  limits.payment,
  validate(S.cardVirtual),
  money('card.virtual', async (req) => {
    const b = req.body;
    if (await Card.exists({ user: req.user._id, type: 'virtual' })) throw E.conflict('You already have a virtual card.', 'CARD_EXISTS');
    const cfg = await getConfig();
    await verifyPin(req.user._id, b.pin);
    const issuanceMinor = cfg.feesMinor.cardIssuance;
    let card;
    const out = await payDebit({
      user: req.user,
      kind: 'card',
      subtype: 'card_issue',
      code: CODES.card,
      amountMinor: b.amount,
      feeMinor: issuanceMinor,
      details: { loadedMinor: b.amount },
      perform: async (txn) => {
        const issued = await providers.cardIssuer.issueVirtual({ holder: holderOf(req.user), reference: txn.reference });
        try {
          card = await Card.create({
            user: req.user._id,
            type: 'virtual',
            panEnc: encrypt(issued.pan),
            cvvEnc: encrypt(issued.cvv),
            last4: issued.pan.slice(-4),
            expiryMonth: issued.expiryMonth,
            expiryYear: issued.expiryYear,
            holder: holderOf(req.user),
            balanceMinor: b.amount,
            issuancePaidMinor: issuanceMinor,
            providerRef: issued.providerRef,
          });
        } catch (err) {
          if (isDuplicateKey(err)) throw new ProviderError('You already have a virtual card.', { outcome: 'failed', code: 'CARD_EXISTS' });
          throw err;
        }
        return { providerRef: issued.providerRef, details: { last4: card.last4, loadedMinor: b.amount } };
      },
    });
    return { card: card ? presentCard(card) : null, transaction: present(out.txn), balance: fromMinor(out.balanceMinor) };
  }),
);

router.post(
  '/virtual/details',
  limits.pin,
  validate(S.cardDetails),
  asyncHandler(async (req, res) => {
    await verifyPin(req.user._id, req.body.pin);
    const card = await Card.findOne({ user: req.user._id, type: 'virtual' }).select('+panEnc +cvvEnc');
    if (!card || !card.panEnc) throw E.notFound('You do not have a virtual card yet.');
    log.info('Card details viewed', { userId: String(req.user._id), cardId: String(card._id) });
    const yy = String(card.expiryYear % 100).padStart(2, '0');
    res.set('Cache-Control', 'no-store');
    res.json({ number: decrypt(card.panEnc), cvv: decrypt(card.cvvEnc), expiry: `${String(card.expiryMonth).padStart(2, '0')}/${yy}` });
  }),
);

router.post(
  '/virtual/freeze',
  validate(S.cardFreeze),
  asyncHandler(async (req, res) => {
    const { frozen } = req.body;
    const card = await Card.findOneAndUpdate(
      { user: req.user._id, type: 'virtual', status: { $ne: 'blocked' } },
      { $set: { frozen, status: frozen ? 'frozen' : 'active' } },
      { new: true },
    );
    if (!card) throw E.notFound('You do not have a virtual card.');
    res.json({ card: presentCard(card) });
  }),
);

router.post(
  '/virtual/fund',
  limits.payment,
  validate(S.cardFund),
  money('card.fund', async (req) => {
    const b = req.body;
    const existing = await Card.findOne({ user: req.user._id, type: 'virtual' });
    if (!existing) throw E.notFound('You do not have a virtual card yet.');
    if (existing.frozen || existing.status === 'blocked') throw E.validation('Unfreeze your card before adding money.', 'CARD_FROZEN');
    await verifyPin(req.user._id, b.pin);
    const out = await payDebit({
      user: req.user,
      kind: 'card',
      subtype: 'card_fund',
      code: CODES.card,
      amountMinor: b.amount,
      details: { last4: existing.last4 },
      perform: async (txn) => {
        const r = await providers.cardIssuer.fundVirtual({ providerRef: existing.providerRef, amountMinor: b.amount, reference: txn.reference });
        await Card.updateOne({ _id: existing._id }, { $inc: { balanceMinor: b.amount } });
        return { providerRef: r.providerRef };
      },
    });
    const card = await Card.findById(existing._id);
    return { card: presentCard(card), transaction: present(out.txn), balance: fromMinor(out.balanceMinor) };
  }),
);

router.post(
  '/physical',
  limits.payment,
  validate(S.cardPhysical),
  money('card.physical', async (req) => {
    const b = req.body;
    const cfg = await getConfig();
    await verifyPin(req.user._id, b.pin);
    let card;
    const out = await payDebit({
      user: req.user,
      kind: 'card',
      subtype: 'card_physical',
      code: CODES.card,
      amountMinor: cfg.feesMinor.physicalCard,
      details: { name: b.name, phone: b.phone, address: b.address, city: b.city, state: b.state },
      perform: async (txn) => {
        const r = await providers.cardIssuer.orderPhysical({ name: b.name, phone: b.phone, address: b.address, city: b.city, state: b.state, reference: txn.reference });
        card = await Card.create({
          user: req.user._id,
          type: 'physical',
          holder: b.name.toUpperCase(),
          status: 'pending',
          issuancePaidMinor: cfg.feesMinor.physicalCard,
          providerRef: r.providerRef,
          requestReference: txn.reference,
        });
        return { providerRef: r.providerRef };
      },
    });
    return {
      card: card ? presentCard(card) : null,
      request: { id: card ? String(card._id) : '', reference: out.txn.reference, status: 'pending', createdAt: iso(out.txn.createdAt) },
      transaction: present(out.txn),
      balance: fromMinor(out.balanceMinor),
    };
  }),
);

module.exports = router;
