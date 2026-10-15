'use strict';
const express = require('express');
const { User } = require('../models');
const providers = require('../providers');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const limits = require('../middleware/limits');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { NotConfiguredError, ProviderError } = require('../providers/errors');
const { getConfig } = require('../services/catalog');

const router = express.Router();
router.use(requireAuth, limits.lookup);

/** Maps partner failures to clean API errors. */
async function viaProvider(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotConfiguredError) throw E.unavailable('This lookup is not available yet.', 'PROVIDER_NOT_CONFIGURED');
    if (err instanceof ProviderError) throw E.upstream(err.message, 'LOOKUP_FAILED');
    throw err;
  }
}

router.post(
  '/bank',
  validate(S.lookupBank),
  asyncHandler(async (req, res) => {
    const cfg = await getConfig();
    if (!cfg.banks.includes(req.body.bank)) throw E.validation('Choose a valid bank.');
    const r = await viaProvider(() => providers.bank.nameEnquiry(req.body));
    if (!r) throw E.notFound('We could not find that account. Check the number and bank.');
    res.json({ accountName: r.accountName });
  }),
);

router.post(
  '/meter',
  validate(S.lookupMeter),
  asyncHandler(async (req, res) => {
    const cfg = await getConfig();
    if (!cfg.electricity.some((p) => p.name === req.body.provider)) throw E.validation('Choose a valid electricity provider.');
    const r = await viaProvider(() =>
      providers.bills.validateCustomer({ category: 'electricity', provider: req.body.provider, number: req.body.meter }),
    );
    if (!r) throw E.notFound('We could not find that meter. Check the number.');
    res.json({ customerName: r.customerName, address: r.address || '' });
  }),
);

router.post(
  '/customer',
  validate(S.lookupCustomer),
  asyncHandler(async (req, res) => {
    const { category, provider, number } = req.body;
    const cfg = await getConfig();
    if (!cfg[category].some((p) => p.name === provider)) throw E.validation('Choose a valid provider.');
    const r = await viaProvider(() => providers.bills.validateCustomer({ category, provider, number }));
    if (!r) throw E.notFound('We could not find that account. Check the number.');
    res.json({ customerName: r.customerName });
  }),
);

router.post(
  '/user',
  validate(S.lookupUser),
  asyncHandler(async (req, res) => {
    const q = req.body.accountNumber ? { accountNumber: req.body.accountNumber } : { phone: req.body.phone };
    const u = await User.findOne({ ...q, status: 'active', onboardingStep: 'done' }).select('firstName lastName accountNumber');
    if (!u || String(u._id) === String(req.user._id)) throw E.notFound('We could not find a TrustPay account for that.');
    res.json({ fullName: `${u.firstName} ${u.lastName}`.trim(), accountNumber: u.accountNumber });
  }),
);

router.post(
  '/merchant',
  validate(S.lookupMerchant),
  asyncHandler(async (req, res) => {
    const m = await User.findOne({ merchantCode: req.body.code, status: 'active', onboardingStep: 'done' }).select('firstName lastName businessName');
    if (!m || String(m._id) === String(req.user._id)) throw E.notFound('We could not find a merchant with that code.');
    res.json({ name: m.businessName || `${m.firstName} ${m.lastName}`.trim(), code: req.body.code });
  }),
);

router.post(
  '/wallet',
  validate(S.lookupWallet),
  asyncHandler(async (req, res) => {
    const cfg = await getConfig();
    if (!cfg.mobileMoney.includes(req.body.provider)) throw E.validation('Choose a valid wallet provider.');
    const r = await viaProvider(() => providers.mobileMoney.nameEnquiry(req.body));
    if (!r) throw E.notFound('We could not find that wallet. Check the number.');
    res.json({ holderName: r.holderName });
  }),
);

module.exports = router;
