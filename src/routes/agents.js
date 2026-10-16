'use strict';
/**
 * Cash-in / cash-out agents. An agent is an ordinary customer an admin switched on; the agent's wallet
 * balance is their float.
 *   Cash out: the customer pays the agent from their wallet (fee included) and the agent hands over cash.
 *   Cash in:  the customer hands the agent cash and the agent sends the same amount from their float.
 */
const express = require('express');
const { User, Txn } = require('../models');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth, requireOnboarded } = require('../middleware/auth');
const limits = require('../middleware/limits');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { CODES } = require('../utils/references');
const { fromMinor } = require('../utils/money');
const { verifyPin } = require('../services/security');
const { assertCanTransact, fullName } = require('../services/wallet');
const { assertCanReceive } = require('../services/tiers');
const { idempotent } = require('../services/idempotency');
const { moveMoney } = require('../services/p2p');
const { present } = require('../services/presenter');
const { cashOutQuote, getFees } = require('../services/agentFees');
const { startOfDayUtc } = require('../utils/time');
const { formatLocal } = require('../utils/phone');

const router = express.Router();
router.use(requireAuth, requireOnboarded);

const findAgent = async (code) => {
  const a = await User.findOne({ agentCode: code, isAgent: true, status: 'active', onboardingStep: 'done' }).select('firstName lastName businessName accountNumber phone');
  return a;
};
const agentName = (a) => a.businessName || fullName(a);

/** What a customer sees before paying: the agent's name and what a cash-out costs. */
router.get(
  '/lookup',
  limits.lookup,
  validate(S.agentLookup, 'query'),
  asyncHandler(async (req, res) => {
    const a = await findAgent(req.query.code);
    if (!a || String(a._id) === String(req.user._id)) throw E.notFound('We could not find an agent with that code.');
    const amount = req.query.amount;
    const quote = amount ? await cashOutQuote(amount) : null;
    res.json({
      agent: { name: agentName(a), code: req.query.code, phone: formatLocal(a.phone) },
      ...(quote ? { quote: { amount: fromMinor(amount), fee: fromMinor(quote.feeMinor), total: fromMinor(quote.totalMinor) } } : {}),
    });
  }),
);

router.get(
  '/fees',
  asyncHandler(async (req, res) => {
    const f = await getFees();
    res.json({ cashOutPercent: f.cashOutBps / 100, minFee: fromMinor(f.minFeeMinor), agentSharePercent: f.agentSharePct });
  }),
);

/** Agent home: code, float, today's work. */
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const u = await User.findById(req.user._id).select('isAgent agentCode balanceMinor').lean();
    if (!u.isAgent) return res.json({ isAgent: false });
    const since = startOfDayUtc();
    const rows = await Txn.aggregate([
      { $match: { user: u._id, kind: 'agent', status: 'Successful', createdAt: { $gte: since } } },
      { $group: { _id: '$subtype', count: { $sum: 1 }, volume: { $sum: '$amountMinor' }, total: { $sum: '$totalMinor' } } },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r._id, r]));
    const cashIn = by.agent_cashin_out || { count: 0, volume: 0 };
    const cashOut = by.agent_cashout_in || { count: 0, volume: 0, total: 0 };
    return res.json({
      isAgent: true,
      code: u.agentCode,
      float: fromMinor(u.balanceMinor),
      today: {
        cashInCount: cashIn.count,
        cashInAmount: fromMinor(cashIn.volume),
        cashOutCount: cashOut.count,
        cashOutAmount: fromMinor(cashOut.volume),
        commission: fromMinor(Math.max(0, (cashOut.total || 0) - (cashOut.volume || 0))),
      },
    });
  }),
);

/** Agent checks who they are about to put money into. */
router.get(
  '/customer',
  limits.lookup,
  validate(S.agentCustomer, 'query'),
  asyncHandler(async (req, res) => {
    if (!req.user.isAgent) throw E.forbidden('Only agents can do this.', 'NOT_AGENT');
    const c = await User.findOne(req.query.phone ? { phone: req.query.phone } : { accountNumber: req.query.accountNumber })
      .select('firstName lastName accountNumber phone status onboardingStep');
    if (!c || c.status !== 'active' || c.onboardingStep !== 'done' || String(c._id) === String(req.user._id)) {
      throw E.notFound('We could not find a TrustPay account for that number.');
    }
    res.json({ customer: { name: fullName(c), accountNumber: c.accountNumber, phone: formatLocal(c.phone) } });
  }),
);

/** Customer withdraws cash from an agent. */
router.post(
  '/cash-out',
  limits.payment,
  validate(S.agentCashOut),
  asyncHandler(async (req, res) => {
    const out = await idempotent(req, 'agent.cashout', async () => {
      assertCanTransact(req.user);
      const b = req.body;
      const agent = await findAgent(b.code);
      if (!agent || String(agent._id) === String(req.user._id)) throw E.validation('We could not find an agent with that code.');
      const q = await cashOutQuote(b.amount);
      await assertCanReceive(agent._id, b.amount + q.commissionMinor, { self: false });
      await verifyPin(req.user._id, b.pin);
      const result = await moveMoney({
        payer: req.user,
        payee: agent,
        kind: 'agent',
        code: CODES.agent,
        outSubtype: 'agent_cashout_out',
        inSubtype: 'agent_cashout_in',
        amountMinor: b.amount,
        feeMinor: q.feeMinor,
        payeeExtraMinor: q.commissionMinor,
        outDetails: { agentName: agentName(agent), agentCode: b.code, cashMinor: b.amount },
        inDetails: { customerName: fullName(req.user), customerAccount: req.user.accountNumber, cashMinor: b.amount },
        notice: { title: 'Cash out received', body: (amt) => `${fullName(req.user)} sent ${amt} for a cash withdrawal. Hand over the cash.` },
      });
      return { status: 200, body: { transaction: present(result.txn), balance: fromMinor(result.balanceMinor) } };
    });
    res.status(out.status).json(out.body);
  }),
);

/** Agent puts a customer's cash into their wallet. */
router.post(
  '/cash-in',
  limits.payment,
  validate(S.agentCashIn),
  asyncHandler(async (req, res) => {
    if (!req.user.isAgent) throw E.forbidden('Only agents can do this.', 'NOT_AGENT');
    const out = await idempotent(req, 'agent.cashin', async () => {
      assertCanTransact(req.user);
      const b = req.body;
      const c = await User.findOne(b.phone ? { phone: b.phone } : { accountNumber: b.accountNumber }).select('firstName lastName accountNumber status onboardingStep');
      if (!c || c.status !== 'active' || c.onboardingStep !== 'done' || String(c._id) === String(req.user._id)) {
        throw E.validation('We could not find a TrustPay account for that number.');
      }
      await assertCanReceive(c._id, b.amount, { self: false });
      await verifyPin(req.user._id, b.pin);
      const me = req.user;
      const result = await moveMoney({
        payer: me,
        payee: c,
        kind: 'agent',
        code: CODES.agent,
        outSubtype: 'agent_cashin_out',
        inSubtype: 'agent_cashin_in',
        amountMinor: b.amount,
        outDetails: { customerName: fullName(c), customerAccount: c.accountNumber },
        inDetails: { agentName: agentName(me), agentCode: me.agentCode },
        notice: { title: 'Cash added', body: (amt) => `${amt} was added to your wallet by agent ${agentName(me)}.` },
      });
      return { status: 200, body: { transaction: present(result.txn), balance: fromMinor(result.balanceMinor) } };
    });
    res.status(out.status).json(out.body);
  }),
);

module.exports = router;
