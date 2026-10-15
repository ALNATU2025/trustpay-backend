'use strict';
/** Africa/Freetown is UTC+0 year-round, so UTC accessors are local time. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n) => String(n).padStart(2, '0');

const hhmm = (d) => `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
/** `D Mon YYYY · HH:mm` */
const dateTime = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${hhmm(d)}`;
const shortDate = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
const ddmmyy = (d = new Date()) => `${two(d.getUTCDate())}${two(d.getUTCMonth() + 1)}${two(d.getUTCFullYear() % 100)}`;
const startOfDayUtc = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/** Add N business days (Mon-Fri) to a date. */
function addBusinessDays(d, n) {
  const out = new Date(d.getTime());
  let left = n;
  while (left > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    const dow = out.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return out;
}

module.exports = { MONTHS, DAYS, hhmm, dateTime, shortDate, ddmmyy, startOfDayUtc, addDays, addBusinessDays };
