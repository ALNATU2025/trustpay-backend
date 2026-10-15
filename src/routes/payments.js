'use strict';
const express = require('express');
const providers = require('../providers');
const { User, Recipient, Txn } = require('../models');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth, requireOnboarded } = require('../middleware/auth');
const limits = require('../middleware/limits');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { CODES, createWithReference } = require('../utils/references');
const { fromMinor, bpsOf } = require('../utils/money');
const { ProviderError, NotConfiguredError } = require('../providers/errors');
const { getConfig } = require('../services/catalog');
const { verifyPin } = require('../services/security');
const { payDebit, payCredit, creditWallet, assertCanTransact, searchText, fullName } = require('../services/wallet');
const { idempotent } = require('../services/idempotency');
const { present } = require('../services/presenter');

const router = express.Router();
router.use(requireAuth, requireOnboarded, limits.payment);

const pack = (out, extra = {}) => ({ transaction: present(out.txn), balance: fromMinor(out.balanceMinor), ...extra });

/** Runs a payment once per Idempotency-Key and sends the PaymentResult. */
function handle(route, run) {
  return asyncHandler(async (req, res) => {
    const out = await idempotent(req, route, async () => {
      assertCanTransact(req.user);
      const result = await run(req);
      return { status: result.status || 200, body: result.body };
    });
    res.status(out.status).json(out.body);
  });
}

/** The partner may fail while we only *look up* a name: turn that into a clean 4xx/5xx. */
async function lookup(fn, notFound) {
  try {
    const r = await fn();
    if (!r) throw E.validation(notFound);
    return r;
  } catch (err) {
    if (err instanceof NotConfiguredError) throw E.unavailable('This service is not available yet.', 'PROVIDER_NOT_CONFIGURED');
    if (err instanceof ProviderError) throw E.upstream(err.message, 'LOOKUP_FAILED');
    throw err;
  }
}

const pickProvider = (list, name, label) => {
  const found = list.find((p) => (typeof p === 'string' ? p === name : p.name === name));
  if (!found) throw E.validation(`Choose a valid ${label}.`);
  return found;
};

/* --------------------------------------------------------------- transfers */

router.post(
  '/transfer/bank',
  validate(S.transferBank),
  handle('transfer.bank', async (req) => {
    const b = req.body;
    const cfg = await getConfig();
    pickProvider(cfg.banks, b.bank, 'bank');
    await verifyPin(req.user._id, b.pin);
    // Never trust the account name the app sends: ask the bank again.
    const ne = await lookup(() => providers.bank.nameEnquiry({ bank: b.bank, accountNumber: b.accountNumber }), 'We could not verify that account.');
    const out = await payDebit({
      user: req.user,
      kind: 'transfer',
      subtype: 'transfer_bank_out',
      code: CODES.transfer,
      amountMinor: b.amount,
      feeMinor: cfg.feesMinor.transfer,
      details: { bank: b.bank, accountNumber: b.accountNumber, accountName: ne.accountName, note: b.note },
      perform: async (txn) =>
        providers.bank.transfer({
          bank: b.bank,
          accountNumber: b.accountNumber,
          accountName: ne.accountName,
          amountMinor: b.amount,
          reference: txn.reference,
          narration: b.note || 'TrustPay transfer',
        }),
    });
    if (b.saveRecipient && out.txn.status === 'Successful') {
      await Recipient.updateOne(
        { user: req.user._id, bank: b.bank, accountNumber: b.accountNumber },
        { $set: { accountName: ne.accountName } },
        { upsert: true },
      ).catch(() => {});
    }
    return { body: pack(out) };
  }),
);

router.post(
  '/transfer/user',
  validate(S.transferUser),
  handle('transfer.user', async (req) => {
    const b = req.body;
    const to = await User.findOne({ accountNumber: b.accountNumber, status: 'active', onboardingStep: 'done' }).select('firstName lastName accountNumber');
    if (!to || String(to._id) === String(req.user._id)) throw E.validation('We could not find a TrustPay account for that number.');
    await verifyPin(req.user._id, b.pin);
    const toName = fullName(to);
    const out = await payDebit({
      user: req.user,
      kind: 'transfer',
      subtype: 'transfer_user_out',
      code: CODES.transfer,
      amountMinor: b.amount,
      feeMinor: 0,
      details: { accountName: toName, accountNumber: to.accountNumber, note: b.note },
      perform: async (txn) => {
        try {
          const inbound = await createWithReference(Txn, CODES.transfer, (reference) => ({
            user: to._id,
            reference,
            kind: 'transfer',
            subtype: 'transfer_user_in',
            direction: 'credit',
            amountMinor: b.amount,
            feeMinor: 0,
            totalMinor: b.amount,
            status: 'Pending',
            details: { senderName: fullName(req.user), senderAccount: req.user.accountNumber, note: b.note },
            ownerName: toName,
            ownerAccount: to.accountNumber,
            search: searchText([reference, fullName(req.user), req.user.accountNumber]),
            externalRef: `in:${txn._id}`,
          }));
          const credit = await creditWallet(to._id, b.amount, `in:${txn._id}`);
          await Txn.updateOne({ _id: inbound._id }, { $set: { status: 'Successful', balanceAfterMinor: credit.balanceMinor } });
        } catch (err) {
          // Nothing reached the recipient if we land here before the credit, so the sender is refunded.
          throw new ProviderError('We could not complete the transfer.', { outcome: 'failed' });
        }
        return {};
      },
    });
    return { body: pack(out) };
  }),
);

router.post(
  '/mobile-money/send',
  validate(S.mmSend),
  handle('mm.send', async (req) => {
    const b = req.body;
    const cfg = await getConfig();
    pickProvider(cfg.mobileMoney, b.provider, 'wallet provider');
    await verifyPin(req.user._id, b.pin);
    const ne = await lookup(() => providers.mobileMoney.nameEnquiry({ provider: b.provider, number: b.number }), 'We could not find that wallet.');
    const out = await payDebit({
      user: req.user,
      kind: 'mobile_money',
      subtype: 'mm_send',
      code: CODES.mmSend,
      amountMinor: b.amount,
      feeMinor: cfg.feesMinor.mobileMoneySend,
      details: { provider: b.provider, number: b.number, holderName: ne.holderName },
      perform: async (txn) => providers.mobileMoney.send({ provider: b.provider, number: b.number, amountMinor: b.amount, reference: txn.reference }),
    });
    return { body: pack(out) };
  }),
);

router.post(
  '/mobile-money/add',
  validate(S.mmAdd),
  handle('mm.add', async (req) => {
    const b = req.body;
    const cfg = await getConfig();
    pickProvider(cfg.mobileMoney, b.provider, 'wallet provider');
    const ne = await lookup(() => providers.mobileMoney.nameEnquiry({ provider: b.provider, number: b.number }), 'We could not find that wallet.');
    const out = await payCredit({
      user: req.user,
      kind: 'funding',
      subtype: 'mm_add',
      code: CODES.mmAdd,
      amountMinor: b.amount,
      details: { provider: b.provider, number: b.number, holderName: ne.holderName },
      perform: async (txn) =>
        providers.mobileMoney.collect({ provider: b.provider, number: b.number, amountMinor: b.amount, code: b.code, reference: txn.reference }),
    });
    return { body: pack(out) };
  }),
);

router.post(
  '/funding/card',
  validate(S.fundingCard),
  handle('funding.card', async (req) => {
    const b = req.body;
    const cfg = await getConfig();
    const feeMinor = bpsOf(b.amount, cfg.feeRatesBps.cardFunding || 0);
    const out = await payCredit({
      user: req.user,
      kind: 'funding',
      subtype: 'funding_card',
      code: CODES.funding,
      amountMinor: b.amount,
      feeMinor,
      details: { brand: b.brand, last4: b.cardLast4 },
      // The card is charged the amount plus the fee; the wallet receives the amount.
      perform: async (txn) =>
        providers.cardAcquirer.charge({ amountMinor: b.amount + feeMinor, feeMinor, cardLast4: b.cardLast4, brand: b.brand, reference: txn.reference }),
    });
    return { body: pack(out) };
  }),
);

/* ------------------------------------------------------------------- bills */

router.post(
  '/bills',
  validate(S.bills),
  handle('bills', async (req) => {
    const b = req.body;
    if (b.category !== 'electricity') throw E.validation('Use the subscription payment for TV and internet.');
    const cfg = await getConfig();
    pickProvider(cfg.electricity, b.provider, 'electricity provider');
    const prepaid = b.prepaid !== false;
    await verifyPin(req.user._id, b.pin);
    const customer = await lookup(
      () => providers.bills.validateCustomer({ category: 'electricity', provider: b.provider, number: b.meter }),
      'We could not find that meter. Check the number.',
    );
    const out = await payDebit({
      user: req.user,
      kind: 'bill',
      subtype: 'bill_electricity',
      code: CODES.bills,
      amountMinor: b.amount,
      feeMinor: cfg.feesMinor.bill,
      details: { provider: b.provider, prepaid, meter: b.meter, customer: customer.customerName, phone: b.phone },
      perform: async (txn) => {
        const r = await providers.bills.payBill({
          category: 'electricity',
          provider: b.provider,
          prepaid,
          number: b.meter,
          amountMinor: b.amount,
          reference: txn.reference,
          phone: b.phone,
        });
        return { providerRef: r.providerRef, token: r.token, details: r.units ? { units: r.units } : undefined };
      },
    });
    return { body: pack(out) };
  }),
);

router.post(
  '/subscription',
  validate(S.subscription),
  handle('subscription', async (req) => {
    const b = req.body;
    const cfg = await getConfig();
    pickProvider(cfg[b.category], b.provider, 'provider');
    const pkg = (b.category === 'tv' ? cfg.tvPackages : cfg.internetPackages).find((p) => p.id === b.packageId);
    if (!pkg) throw E.validation('Choose a valid package.');
    await verifyPin(req.user._id, b.pin);
    await lookup(
      () => providers.bills.validateCustomer({ category: b.category, provider: b.provider, number: b.accountNumber }),
      'We could not find that account. Check the number.',
    );
    const out = await payDebit({
      user: req.user,
      kind: b.category,
      subtype: b.category === 'tv' ? 'bill_tv' : 'bill_internet',
      code: b.category === 'tv' ? CODES.tv : CODES.internet,
      amountMinor: pkg.priceMinor, // the price comes from the catalog, never from the app
      feeMinor: cfg.feesMinor.bill,
      details: { provider: b.provider, number: b.accountNumber, packageId: pkg.id, packageName: pkg.name, phone: b.phone },
      perform: async (txn) =>
        providers.bills.paySubscription({
          category: b.category,
          provider: b.provider,
          number: b.accountNumber,
          packageId: pkg.id,
          amountMinor: pkg.priceMinor,
          reference: txn.reference,
          phone: b.phone,
        }),
    });
    return { body: pack(out) };
  }),
);

router.post(
  '/airtime',
  validate(S.airtime),
  handle('airtime', async (req) => {
    const b = req.body;
    const cfg = await getConfig();
    pickProvider(cfg.networks, b.network, 'network');
    await verifyPin(req.user._id, b.pin);
    const out = await payDebit({
      user: req.user,
      kind: 'airtime',
      subtype: 'airtime',
      code: CODES.airtime,
      amountMinor: b.amount,
      details: { network: b.network, phone: b.phone },
      perform: async (txn) => providers.airtime.topup({ network: b.network, phone: b.phone, amountMinor: b.amount, reference: txn.reference }),
    });
    return { body: pack(out) };
  }),
);

router.post(
  '/data',
  validate(S.data),
  handle('data', async (req) => {
    const b = req.body;
    const cfg = await getConfig();
    pickProvider(cfg.networks, b.network, 'network');
    const plan = cfg.dataPlans.find((p) => p.id === b.planId);
    if (!plan) throw E.validation('Choose a valid data plan.');
    await verifyPin(req.user._id, b.pin);
    const out = await payDebit({
      user: req.user,
      kind: 'data',
      subtype: 'data',
      code: CODES.data,
      amountMinor: plan.priceMinor,
      details: { network: b.network, phone: b.phone, planId: plan.id, planSize: plan.size, days: plan.days },
      perform: async (txn) => providers.airtime.dataBundle({ network: b.network, phone: b.phone, plan, reference: txn.reference }),
    });
    return { body: pack(out) };
  }),
);

module.exports = router;
module.exports.handle = handle;
module.exports.pack = pack;
