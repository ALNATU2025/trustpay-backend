'use strict';
const express = require('express');
const { Ticket, Message } = require('../models');
const S = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const limits = require('../middleware/limits');
const asyncHandler = require('../utils/asyncHandler');
const { E } = require('../utils/errors');
const { CODES, createWithReference, isDuplicateKey } = require('../utils/references');
const { presentTicket, presentMessage } = require('../services/presenter');

const router = express.Router();
router.use(requireAuth);

async function addMessage(ticket, { from, text, author }) {
  const msg = await Message.create({ ticket: ticket._id, from, text, author });
  await Ticket.updateOne(
    { _id: ticket._id },
    { $set: { lastMessage: { from, text: text.slice(0, 200), createdAt: msg.createdAt }, lastMessageAt: msg.createdAt } },
  );
  return msg;
}

async function ownTicket(req) {
  const t = await Ticket.findOne({ _id: req.params.id, user: req.user._id });
  if (!t) throw E.notFound('We could not find that conversation.');
  return t;
}

const thread = async (t) => ({
  ticket: presentTicket(t),
  messages: (await Message.find({ ticket: t._id }).sort({ createdAt: 1, _id: 1 }).limit(500).lean()).map(presentMessage),
});

router.get(
  '/tickets',
  asyncHandler(async (req, res) => {
    const rows = await Ticket.find({ user: req.user._id, type: 'ticket' }).sort({ lastMessageAt: -1 }).limit(50).lean();
    res.json({ items: rows.map((t) => presentTicket(t)) });
  }),
);

router.post(
  '/tickets',
  limits.chat,
  validate(S.ticketCreate),
  asyncHandler(async (req, res) => {
    const open = await Ticket.countDocuments({ user: req.user._id, type: 'ticket', status: 'open' });
    if (open >= 10) throw E.tooMany('You have many open requests. Please wait for replies before opening more.', 'TOO_MANY_OPEN');
    const ticket = await createWithReference(Ticket, CODES.support, (reference) => ({
      user: req.user._id,
      reference,
      type: 'ticket',
      topic: req.body.topic,
    }));
    await addMessage(ticket, { from: 'user', text: req.body.message, author: req.user._id });
    res.status(201).json(await thread(await Ticket.findById(ticket._id)));
  }),
);

router.get(
  '/tickets/:id',
  asyncHandler(async (req, res) => {
    res.json(await thread(await ownTicket(req)));
  }),
);

router.post(
  '/tickets/:id/messages',
  limits.chat,
  validate(S.message),
  asyncHandler(async (req, res) => {
    const t = await ownTicket(req);
    if (t.status === 'closed') throw E.conflict('This conversation is closed. Please start a new one.', 'TICKET_CLOSED');
    const msg = await addMessage(t, { from: 'user', text: req.body.text, author: req.user._id });
    res.status(201).json({ message: presentMessage(msg) });
  }),
);

/* ---- live chat: one open conversation per customer ---- */

async function chatTicket(user) {
  const found = await Ticket.findOne({ user: user._id, type: 'chat', status: 'open' });
  if (found) return found;
  try {
    const t = await createWithReference(Ticket, CODES.support, (reference) => ({ user: user._id, reference, type: 'chat', topic: 'Live chat' }));
    await addMessage(t, { from: 'agent', text: `Hi ${user.firstName}, how can we help you today?` });
    return Ticket.findById(t._id);
  } catch (err) {
    if (isDuplicateKey(err)) return Ticket.findOne({ user: user._id, type: 'chat', status: 'open' });
    throw err;
  }
}

router.get(
  '/chat',
  asyncHandler(async (req, res) => {
    res.json(await thread(await chatTicket(req.user)));
  }),
);

router.post(
  '/chat',
  limits.chat,
  validate(S.message),
  asyncHandler(async (req, res) => {
    const t = await chatTicket(req.user);
    const msg = await addMessage(t, { from: 'user', text: req.body.text, author: req.user._id });
    res.status(201).json({ message: presentMessage(msg) });
  }),
);

module.exports = router;
module.exports.addMessage = addMessage;
