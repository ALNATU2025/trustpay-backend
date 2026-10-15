'use strict';
const { User } = require('../models');
const { E } = require('../utils/errors');
const { verifyToken } = require('../services/security');
const asyncHandler = require('../utils/asyncHandler');

/** Requires a valid session token. Loads the user (fresh from the DB, so suspensions apply at once). */
const requireAuth = asyncHandler(async (req, res, next) => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) throw E.unauthorized('Please sign in to continue.');
  const payload = verifyToken(m[1]);
  if (payload.purpose) throw E.unauthorized();
  const user = await User.findById(payload.sub);
  if (!user || (user.tokenVersion || 0) !== payload.tv) throw E.unauthorized('Your session has expired. Please sign in again.');
  if (user.status === 'suspended') throw E.forbidden('Your account is suspended. Please contact support.', 'SUSPENDED');
  req.user = user;
  next();
});

/** Requires the signed-in user to have one of the given roles. */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(E.forbidden('You do not have access to this.'));
  return next();
};

/** Onboarding must be finished before money screens work. */
const requireOnboarded = (req, res, next) => {
  if (req.user.onboardingStep !== 'done') return next(E.forbidden('Finish setting up your account first.', 'ONBOARDING_INCOMPLETE'));
  return next();
};

module.exports = { requireAuth, requireRole, requireOnboarded };
