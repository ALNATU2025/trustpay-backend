'use strict';
/**
 * Sierra Leone phone normaliser.
 *
 * STORED FORM: the 8 national significant digits, no spaces, no leading 0, no country code
 * (e.g. "76123456"). All of these map to the same stored value:
 *   "076 123 456", "076123456", "+232 76 123 456", "+23276123456", "0023276123456", "76123456".
 * Returns null when the input cannot be a Sierra Leone number.
 */
function normalisePhone(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  let d = String(input).trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(d)) return null;
  d = d.replace(/^\+/, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('232')) d = d.slice(3);
  else if (d.length === 9 && d.startsWith('0')) d = d.slice(1);
  if (!/^[1-9]\d{7}$/.test(d)) return null;
  return d;
}

/** "76123456" -> "076 123 456" */
function formatLocal(stored) {
  const d = `0${stored}`;
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

/** "76123456" -> "+23276123456" */
const toIntl = (stored) => `+232${stored}`;

module.exports = { normalisePhone, formatLocal, toIntl };
