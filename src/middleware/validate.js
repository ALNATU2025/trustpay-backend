'use strict';
const { AppError } = require('../utils/errors');

const words = (key) =>
  String(key)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();

/** Turns a zod issue into one readable sentence. */
function formatIssue(issue) {
  if (!issue) return 'Invalid request.';
  const field = issue.path && issue.path.length ? words(issue.path[issue.path.length - 1]) : 'value';
  const cap = field.charAt(0).toUpperCase() + field.slice(1);
  if (issue.code === 'invalid_type') {
    return issue.received === 'undefined' || issue.received === 'null' ? `${cap} is required.` : `${cap} is not valid.`;
  }
  if (issue.code === 'invalid_enum_value') return `${cap} is not one of the allowed values.`;
  if (issue.code === 'unrecognized_keys') return 'The request has unexpected fields.';
  return issue.message || `${cap} is not valid.`;
}

/** validate(schema, 'body' | 'query' | 'params'): replaces req[source] with the parsed (trimmed/normalised) data. */
const validate = (schema, source = 'body') => (req, res, next) => {
  const input = req[source] && typeof req[source] === 'object' ? req[source] : {};
  const result = schema.safeParse(input);
  if (!result.success) return next(new AppError(422, formatIssue(result.error.issues[0]), 'VALIDATION'));
  req[source] = result.data;
  return next();
};

module.exports = { validate, formatIssue };
