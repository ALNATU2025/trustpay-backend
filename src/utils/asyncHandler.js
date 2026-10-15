'use strict';
/** Wraps an async route handler so rejections reach the error middleware. */
module.exports = (fn) => (req, res, next) => {
  Promise.resolve().then(() => fn(req, res, next)).catch(next);
};
