'use strict';

/** Operational error that maps straight to an HTTP response `{message, code?}`. */
class AppError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.extra = extra; // extra JSON fields merged into the response (e.g. attemptsLeft)
  }
}

const E = {
  badRequest: (m, c, x) => new AppError(400, m, c, x),
  unauthorized: (m = 'Please sign in again.', c = 'UNAUTHORIZED') => new AppError(401, m, c),
  paymentRequired: (m = 'Insufficient balance.', c = 'INSUFFICIENT_FUNDS') => new AppError(402, m, c),
  forbidden: (m = 'You do not have access to this.', c = 'FORBIDDEN', x) => new AppError(403, m, c, x),
  notFound: (m = 'Not found.', c = 'NOT_FOUND') => new AppError(404, m, c),
  conflict: (m, c = 'CONFLICT', x) => new AppError(409, m, c, x),
  validation: (m, c = 'VALIDATION') => new AppError(422, m, c),
  locked: (m, c, x) => new AppError(423, m, c, x),
  tooMany: (m, c = 'RATE_LIMITED', x) => new AppError(429, m, c, x),
  upstream: (m, c = 'PAYMENT_FAILED') => new AppError(502, m, c),
  unavailable: (m, c = 'SERVICE_UNAVAILABLE') => new AppError(503, m, c),
};

module.exports = { AppError, E };
