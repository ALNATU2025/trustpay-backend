'use strict';
const crypto = require('crypto');

function luhnCheckDigit(partial) {
  let sum = 0;
  let double = true;
  for (let i = partial.length - 1; i >= 0; i--) {
    let d = Number(partial[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return String((10 - (sum % 10)) % 10);
}

const isLuhnValid = (num) => /^\d{12,19}$/.test(num) && luhnCheckDigit(num.slice(0, -1)) === num.slice(-1);

/** Luhn-valid PAN of `length` digits starting with `bin`. */
function generatePan(bin = '400000', length = 16) {
  let body = bin;
  while (body.length < length - 1) body += String(crypto.randomInt(0, 10));
  return body + luhnCheckDigit(body);
}

module.exports = { luhnCheckDigit, isLuhnValid, generatePan };
