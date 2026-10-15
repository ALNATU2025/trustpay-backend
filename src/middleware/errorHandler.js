'use strict';
const { ZodError } = require('zod');
const mongoose = require('mongoose');
const env = require('../config/env');
const log = require('../utils/log');
const { AppError } = require('../utils/errors');
const { formatIssue } = require('./validate');

function notFound(req, res) {
  res.status(404).json({ message: 'Route not found.', code: 'NOT_FOUND' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return;

  if (err instanceof AppError) {
    return res.status(err.status).json({ message: err.message, ...(err.code ? { code: err.code } : {}), ...(err.extra || {}) });
  }
  if (err instanceof ZodError) {
    return res.status(422).json({ message: formatIssue(err.issues[0]), code: 'VALIDATION' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'The request body is not valid JSON.', code: 'BAD_JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'The request body is too large.', code: 'PAYLOAD_TOO_LARGE' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ message: 'Your session has expired. Please sign in again.', code: 'TOKEN_EXPIRED' });
  }
  if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
    return res.status(401).json({ message: 'Please sign in again.', code: 'TOKEN_INVALID' });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(404).json({ message: 'Not found.', code: 'NOT_FOUND' });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const first = Object.values(err.errors)[0];
    return res.status(422).json({ message: (first && first.message) || 'Invalid data.', code: 'VALIDATION' });
  }
  if (err && (err.code === 11000 || err.code === 11001)) {
    return res.status(409).json({ message: 'That record already exists.', code: 'DUPLICATE' });
  }

  log.error('Unhandled error', { path: req.originalUrl.split('?')[0], method: req.method, name: err && err.name, message: err && err.message, stack: env.isProd ? undefined : err && err.stack });
  return res.status(500).json({ message: 'Something went wrong. Please try again.', code: 'INTERNAL' });
}

module.exports = { notFound, errorHandler };
