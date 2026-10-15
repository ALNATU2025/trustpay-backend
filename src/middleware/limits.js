'use strict';
const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const handler = (message) => (req, res) => res.status(429).json({ message, code: 'RATE_LIMITED' });

const make = (windowMs, max, message, keyed = false) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => env.isTest, // tests create dozens of accounts from one address
    handler: handler(message),
    ...(keyed ? { keyGenerator: (req) => (req.user ? String(req.user._id) : 'anonymous') } : {}),
  });

const MIN = 60 * 1000;

module.exports = {
  global: make(15 * MIN, 600, 'Too many requests. Please slow down.'),
  auth: make(15 * MIN, 30, 'Too many attempts. Please wait a few minutes and try again.'),
  // Per signed-in user (mount after requireAuth).
  otp: make(15 * MIN, 10, 'Too many code requests. Please wait a few minutes.', true),
  lookup: make(MIN, 40, 'Too many lookups. Please wait a moment.', true),
  payment: make(MIN, 20, 'Too many payment attempts. Please wait a moment.', true),
  pin: make(15 * MIN, 30, 'Too many PIN attempts. Please wait a few minutes.', true),
  chat: make(MIN, 30, 'You are sending messages too quickly.', true),
};
