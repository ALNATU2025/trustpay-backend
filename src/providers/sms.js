'use strict';
/**
 * SMS adapter.  Interface:  send({ to, message, purpose }) -> { providerRef }
 *   `to` is the 8-digit stored phone; the adapter formats it for the gateway (+232...).
 */
const log = require('../utils/log');
const { toIntl } = require('../utils/phone');
const { notConfigured } = require('./errors');
const select = require('./select');

const sandbox = {
  async send({ to, message, purpose }) {
    // SANDBOX ONLY: nothing is sent. The message (including any OTP) goes to the server log
    // so developers can complete flows without an SMS gateway. Never use this in production.
    log.info(`[sandbox:sms] sandbox=true purpose=${purpose} to=${toIntl(to)} message="${message}"`);
    return { providerRef: `sandbox-sms-${Date.now()}`, sandbox: true };
  },
};

// LIVE: plug in your Sierra Leone SMS aggregator / operator bulk-SMS API (e.g. Orange, Africell,
// Qcell bulk SMS, or an aggregator such as Africa's Talking / Twilio) here.
const live = notConfigured('sms', 'an SMS gateway partner (bulk SMS HTTP API)', ['send']);

module.exports = select({ sandbox, live });
