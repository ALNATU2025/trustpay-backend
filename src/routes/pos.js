'use strict';
const express = require('express');
const { Terminal, TerminalRequest, PosPayment, Settlement, PosCharge } = require('../models');
const providers = require('../providers');
const posCharges = require('../services/posCharge');
const { ProviderError, NotConfiguredError } = require('../providers/errors');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth, requireOnboarded } = require('../middleware/auth');
const limits = require('../middleware/limits');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { CODES, createWithReference, isDuplicateKey } = require('../utils/references');
const { randomDigits } = require('../utils/crypto');
const { User } = require('../models');
const { NotConfiguredError: NotCfg } = require('../providers/errors');
const { fromMinor, bpsOf } = require('../utils/money');
const env = require('../config/env');
const { startOfDayUtc, addDays, addBusinessDays, hhmm, shortDate } = require('../utils/time');
const { getConfig } = require('../services/catalog');
const { verifyPin } = require('../services/security');
const { payDebit, assertCanTransact } = require('../services/wallet');
const { idempotent } = require('../services/idempotency');
const { present, presentTerminal, presentPosRequest, iso } = require('../services/presenter');
const { formatLocal } = require('../utils/phone');

const router = express.Router();
router.use(requireAuth, requireOnboarded);

const SETTLE_HOUR_UTC = 16; // 4:00 PM Freetown time (UTC+0)

/** Next 16:00 UTC that has not passed yet. */
function nextSettlementTime(now = new Date()) {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SETTLE_HOUR_UTC));
  return t > now ? t : addDays(t, 1);
}

const kindTitle = (k) => (k === 'card' ? 'Card payment' : k === 'momo' ? 'Mobile money' : 'Bank transfer');

const maskAcct = (n) => (n ? `•• ${String(n).slice(-4)}` : '');
const presentSettlementAccount = (u) =>
  u.settlementAccount && u.settlementAccount.accountNumber
    ? {
        bank: u.settlementAccount.bank,
        accountName: u.settlementAccount.accountName,
        accountNumber: maskAcct(u.settlementAccount.accountNumber),
        payToBank: u.settlementTo === 'bank',
      }
    : null;

const payLine = (p) => ({
  reference: p.reference,
  title: kindTitle(p.kind),
  subtitle: `${hhmm(new Date(p.createdAt))} · ${p.payer || (p.kind === 'card' ? 'Card' : 'Transfer')}`,
  amount: fromMinor(p.amountMinor),
});

/** What would be paid out at the next run, from payments not yet settled. */
async function previewSettlement(ownerId) {
  const open = await PosPayment.find({ owner: ownerId, settled: false }).sort({ createdAt: 1 }).limit(500).lean();
  if (!open.length) return { settlement: null, rolledOver: { amount: 0, count: 0 } };
  const gross = open.reduce((s, p) => s + p.amountMinor, 0);
  const fees = bpsOf(gross, env.settlementFeeBps);
  const today = startOfDayUtc();
  const older = open.filter((p) => new Date(p.createdAt) < today);
  return {
    settlement: {
      id: '',
      reference: 'Scheduled',
      net: fromMinor(gross - fees),
      gross: fromMinor(gross),
      fees: fromMinor(fees),
      count: open.length,
      scheduledFor: iso(nextSettlementTime()),
      status: 'Scheduled',
      destination: 'TrustPay wallet',
      payments: open.slice().reverse().map(payLine),
    },
    rolledOver: { amount: fromMinor(older.reduce((s, p) => s + p.amountMinor, 0)), count: older.length },
  };
}

router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const owner = req.user._id;
    const me = await User.findById(owner).select('settlementAccount settlementTo merchantCode').lean();
    const [terminal, request, todayAgg, recent, preview] = await Promise.all([
      Terminal.findOne({ owner }).lean(),
      TerminalRequest.findOne({ user: owner }).sort({ createdAt: -1 }).lean(),
      PosPayment.aggregate([
        { $match: { owner, createdAt: { $gte: startOfDayUtc() } } },
        { $group: { _id: null, total: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
      ]),
      PosPayment.find({ owner }).sort({ createdAt: -1 }).limit(8).lean(),
      previewSettlement(owner),
    ]);
    const today = todayAgg[0] || { total: 0, count: 0 };
    res.json({
      businessName: req.user.businessName || (request && request.businessName) || '',
      terminal: presentTerminal(terminal),
      settlementAccount: presentSettlementAccount(me || {}),
      merchantCode: (me && me.merchantCode) || null,
      today: { collected: fromMinor(today.total), count: today.count },
      nextSettlement: preview.settlement,
      recent: recent.map((p) => ({
        id: String(p._id),
        title: kindTitle(p.kind),
        subtitle: `${shortDate(new Date(p.createdAt))}, ${hhmm(new Date(p.createdAt))} · ${p.payer || 'Customer'}`,
        amount: fromMinor(p.amountMinor),
        kind: p.kind,
        createdAt: iso(p.createdAt),
      })),
      // A rejected request is only shown for a while so the screen goes back to the "request" state.
      request: request && (request.status !== 'rejected' || Date.now() - new Date(request.updatedAt).getTime() < 7 * 86400000)
        ? presentPosRequest({ ...request, expectedFrom: addBusinessDays(new Date(request.createdAt), 3), expectedTo: addBusinessDays(new Date(request.createdAt), 5) })
        : null,
    });
  }),
);

router.get(
  '/settlements/next',
  asyncHandler(async (req, res) => {
    res.json(await previewSettlement(req.user._id));
  }),
);

router.get(
  '/settlements/:id',
  asyncHandler(async (req, res) => {
    const s = await Settlement.findOne({ _id: req.params.id, owner: req.user._id }).lean();
    if (!s) throw E.notFound('We could not find that settlement.');
    const pays = await PosPayment.find({ settlement: s._id }).sort({ createdAt: -1 }).limit(500).lean();
    res.json({
      settlement: {
        id: String(s._id),
        reference: s.reference,
        net: fromMinor(s.netMinor),
        gross: fromMinor(s.grossMinor),
        fees: fromMinor(s.feeMinor),
        count: s.count,
        scheduledFor: iso(s.scheduledFor),
        status: s.status,
        destination: s.destination,
        payments: pays.map(payLine),
      },
    });
  }),
);

/* ---- phone POS: charge a customer by mobile money ---- */

const presentCharge = (c) => ({
  id: String(c._id),
  reference: c.reference,
  amount: fromMinor(c.amountMinor),
  note: c.note || '',
  customerPhone: formatLocal(c.customerPhone),
  status: c.status,
  ussdCode: c.status === 'Pending' ? c.ussdCode || null : null,
  expiresAt: iso(c.expiresAt),
  failureReason: c.failureReason || '',
  createdAt: iso(c.createdAt),
  paidAt: iso(c.paidAt),
});

router.post(
  '/charges',
  limits.payment,
  validate(S.posCharge),
  asyncHandler(async (req, res) => {
    const out = await idempotent(req, 'pos.charge', async () => {
      assertCanTransact(req.user);
      const b = req.body;
      const name = `${req.user.businessName || req.user.firstName} POS`.slice(0, 64);
      const charge = await createWithReference(PosCharge, CODES.posCharge, (reference) => ({
        owner: req.user._id,
        reference,
        amountMinor: b.amount,
        note: b.note,
        customerPhone: b.number,
        provider: b.provider,
      }));
      let code;
      try {
        code = await Promise.race([
          providers.paymentCode.create({ provider: b.provider, number: b.number, amountMinor: b.amount, reference: charge.reference, name }),
          new Promise((_, rej) => setTimeout(() => rej(new ProviderError('The payment provider is taking too long. Please try again.', { outcome: 'failed' })), 25000)),
        ]);
      } catch (err) {
        const reason = err instanceof ProviderError && err.outcome === 'failed' && err.message ? err.message : 'The payment request could not be created.';
        await PosCharge.updateOne({ _id: charge._id }, { $set: { status: 'Failed', failureReason: reason } });
        if (err instanceof NotConfiguredError || (err instanceof ProviderError && err.code === 'PROVIDER_NOT_CONFIGURED')) {
          throw E.unavailable('This service is not available yet.', 'PROVIDER_NOT_CONFIGURED');
        }
        throw E.upstream(reason, 'PAYMENT_FAILED');
      }
      await PosCharge.updateOne({ _id: charge._id }, { $set: { providerRef: code.id, ussdCode: code.ussdCode || undefined, expiresAt: code.expiresAt || undefined } });
      if (code.instant) await posCharges.markPaid(charge._id);
      const fresh = await PosCharge.findById(charge._id).lean();
      return { status: 201, body: { charge: presentCharge(fresh) } };
    });
    res.status(out.status).json(out.body);
  }),
);

/* ---- linked bank account (settlement account) ---- */

router.get(
  '/settlement-account',
  asyncHandler(async (req, res) => {
    const u = await User.findById(req.user._id).select('settlementAccount settlementTo').lean();
    res.json({ account: presentSettlementAccount(u) });
  }),
);

router.post(
  '/settlement-account',
  limits.pin,
  validate(S.settlementAccount),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const cfg = await getConfig();
    if (!cfg.banks.some((x) => (typeof x === 'string' ? x === b.bank : x.name === b.bank))) throw E.validation('Choose a valid bank.');
    await verifyPin(req.user._id, b.pin);
    let ne;
    try {
      ne = await providers.bank.nameEnquiry({ bank: b.bank, accountNumber: b.accountNumber });
    } catch (err) {
      if (err instanceof NotCfg) throw E.unavailable('This service is not available yet.', 'PROVIDER_NOT_CONFIGURED');
      throw E.upstream('We could not verify that account. Please try again.', 'LOOKUP_FAILED');
    }
    if (!ne || !ne.accountName) throw E.validation('We could not find that bank account. Check the bank and number.');
    const u = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { settlementAccount: { bank: b.bank, accountNumber: b.accountNumber, accountName: ne.accountName }, settlementTo: b.payToBank === false ? 'wallet' : 'bank' } },
      { new: true },
    ).select('settlementAccount settlementTo');
    res.json({ account: presentSettlementAccount(u) });
  }),
);

router.post(
  '/settlement-account/target',
  limits.pin,
  validate(S.settlementTarget),
  asyncHandler(async (req, res) => {
    const u0 = await User.findById(req.user._id).select('settlementAccount');
    if (req.body.payToBank && !(u0.settlementAccount && u0.settlementAccount.accountNumber)) throw E.validation('Link a bank account first.');
    await verifyPin(req.user._id, req.body.pin);
    const u = await User.findByIdAndUpdate(req.user._id, { $set: { settlementTo: req.body.payToBank ? 'bank' : 'wallet' } }, { new: true }).select('settlementAccount settlementTo');
    res.json({ account: presentSettlementAccount(u) });
  }),
);

router.post(
  '/settlement-account/unlink',
  limits.pin,
  validate(S.pinOnly),
  asyncHandler(async (req, res) => {
    await verifyPin(req.user._id, req.body.pin);
    await User.updateOne({ _id: req.user._id }, { $unset: { settlementAccount: 1 }, $set: { settlementTo: 'wallet' } });
    res.json({ account: null });
  }),
);

/** The merchant's permanent code (created on first use). Print it or turn `qr` into a QR code. */
router.get(
  '/code',
  asyncHandler(async (req, res) => {
    let user = await User.findById(req.user._id).select('merchantCode businessName firstName lastName');
    if (!user.merchantCode) {
      for (let i = 0; i < 20 && !user.merchantCode; i++) {
        try {
          const r = await User.findOneAndUpdate(
            { _id: user._id, merchantCode: { $exists: false } },
            { $set: { merchantCode: randomDigits(6) } },
            { new: true },
          ).select('merchantCode businessName firstName lastName');
          user = r || (await User.findById(user._id).select('merchantCode businessName firstName lastName'));
        } catch (err) {
          if (!isDuplicateKey(err)) throw err;
        }
      }
      if (!user.merchantCode) throw E.unavailable('Could not create your merchant code. Please try again.');
    }
    res.json({
      code: user.merchantCode,
      businessName: user.businessName || `${user.firstName} ${user.lastName}`.trim(),
      qr: `trustpay://pay/${user.merchantCode}`,
    });
  }),
);

router.get(
  '/charges',
  asyncHandler(async (req, res) => {
    const rows = await PosCharge.find({ owner: req.user._id }).sort({ createdAt: -1 }).limit(20).lean();
    res.json({ items: rows.map(presentCharge) });
  }),
);

router.get(
  '/charges/:id',
  asyncHandler(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw E.notFound('We could not find that payment request.');
    let c = await PosCharge.findOne({ _id: req.params.id, owner: req.user._id });
    if (!c) throw E.notFound('We could not find that payment request.');
    if (c.status === 'Pending') {
      if (c.expiresAt && c.expiresAt.getTime() + 60000 < Date.now()) await posCharges.markFailed(c._id, 'Expired', 'The payment code expired before the customer paid.');
      else await posCharges.refreshThrottled(c);
      c = await PosCharge.findById(c._id);
    }
    res.json({ charge: presentCharge(c.toObject()) });
  }),
);

router.post(
  '/terminal/toggle',
  limits.pin,
  validate(S.posToggle),
  asyncHandler(async (req, res) => {
    const t = await Terminal.findOneAndUpdate({ owner: req.user._id }, { $set: { status: req.body.enabled ? 'active' : 'disabled' } }, { new: true });
    if (!t) throw E.notFound('You do not have a terminal yet.');
    res.json({ terminal: presentTerminal(t) });
  }),
);

router.post(
  '/terminal/request',
  limits.payment,
  validate(S.posRequest),
  asyncHandler(async (req, res) => {
    const out = await idempotent(req, 'pos.request', async () => {
      assertCanTransact(req.user);
      const b = req.body;
      if (await Terminal.exists({ owner: req.user._id })) throw E.conflict('You already have a POS terminal.', 'TERMINAL_EXISTS');
      if (await TerminalRequest.exists({ user: req.user._id, status: 'pending' })) {
        throw E.conflict('You already have a request being reviewed.', 'REQUEST_PENDING');
      }
      const cfg = await getConfig();
      await verifyPin(req.user._id, b.pin);
      let request;
      const result = await payDebit({
        user: req.user,
        kind: 'pos',
        subtype: 'pos_request',
        code: CODES.pos,
        amountMinor: cfg.feesMinor.terminalDeposit,
        feeMinor: cfg.feesMinor.terminalDelivery,
        details: { businessName: b.businessName, depositMinor: cfg.feesMinor.terminalDeposit, deliveryMinor: cfg.feesMinor.terminalDelivery },
        perform: async (txn) => {
          try {
            request = await TerminalRequest.create({
              user: req.user._id,
              reference: txn.reference,
              businessName: b.businessName,
              category: b.category,
              address: b.address,
              city: b.city,
              state: b.state,
              contact: formatLocal(b.contact),
              depositMinor: cfg.feesMinor.terminalDeposit,
              deliveryMinor: cfg.feesMinor.terminalDelivery,
            });
          } catch (err) {
            if (isDuplicateKey(err)) {
              const { ProviderError } = require('../providers/errors');
              throw new ProviderError('You already have a request being reviewed.', { outcome: 'failed', code: 'REQUEST_PENDING' });
            }
            throw err;
          }
          return {};
        },
      });
      const req2 = request || (await TerminalRequest.findOne({ reference: result.txn.reference }).lean());
      const plain = req2 ? (req2.toObject ? req2.toObject() : req2) : null;
      return {
        status: 200,
        body: {
          request: plain ? presentPosRequest({ ...plain, expectedFrom: addBusinessDays(new Date(), 3), expectedTo: addBusinessDays(new Date(), 5) }) : null,
          transaction: present(result.txn),
          balance: fromMinor(result.balanceMinor),
        },
      };
    });
    res.status(out.status).json(out.body);
  }),
);

module.exports = router;
module.exports.nextSettlementTime = nextSettlementTime;
