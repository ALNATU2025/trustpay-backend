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

// LIVE: real SMS through the gateway named in SMS_PROVIDER (twilio | africastalking | infobip).
// Credentials come from env (see .env.example). Nothing here logs the message body (it contains the OTP).
const { ProviderError } = require('./errors');
const env = require('../config/env');

async function post(url, { headers, body, form }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), env.sms.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: form ? new URLSearchParams(form).toString() : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    throw new ProviderError('SMS gateway did not respond', { outcome: 'unknown', code: 'SMS_TIMEOUT' });
  } finally {
    clearTimeout(timer);
  }
}

const fail = (name, r) => {
  log.error(`SMS gateway ${name} rejected the message`, { status: r.status, body: String(r.text).slice(0, 300) });
  throw new ProviderError(`SMS gateway ${name} rejected the message`, { code: 'SMS_REJECTED' });
};

const gateways = {
  // https://www.twilio.com/docs/messaging/api/message-resource
  async twilio({ to, message }) {
    const c = env.sms.twilio;
    const auth = Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64');
    const form = { To: toIntl(to), Body: message };
    if (c.messagingServiceSid) form.MessagingServiceSid = c.messagingServiceSid;
    else form.From = c.from;
    const r = await post(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`, {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      form,
    });
    if (!r.ok) fail('twilio', r);
    return { providerRef: (r.json && r.json.sid) || `twilio-${Date.now()}` };
  },

  // https://developers.africastalking.com/docs/sms/sending/bulk
  async africastalking({ to, message }) {
    const c = env.sms.at;
    const form = { username: c.username, to: toIntl(to), message };
    if (c.from) form.from = c.from;
    const host = c.username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const r = await post(`https://${host}/version1/messaging`, {
      headers: { apiKey: c.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      form,
    });
    const rec = r.json && r.json.SMSMessageData && r.json.SMSMessageData.Recipients && r.json.SMSMessageData.Recipients[0];
    if (!r.ok || !rec || !/success/i.test(rec.status || '')) fail('africastalking', r);
    return { providerRef: rec.messageId || `at-${Date.now()}` };
  },

  // https://www.infobip.com/docs/api/channels/sms/sms-messaging/outbound-sms/send-sms-message
  async infobip({ to, message }) {
    const c = env.sms.infobip;
    const r = await post(`https://${c.baseUrl.replace(/^https?:\/\//, '')}/sms/2/text/advanced`, {
      headers: { Authorization: `App ${c.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: { messages: [{ from: c.from || 'TrustPay', destinations: [{ to: toIntl(to).replace('+', '') }], text: message }] },
    });
    const m = r.json && r.json.messages && r.json.messages[0];
    if (!r.ok || !m) fail('infobip', r);
    return { providerRef: m.messageId || `infobip-${Date.now()}` };
  },
};

const live = {
  async send(args) {
    const gw = gateways[env.sms.provider];
    if (!gw) throw new ProviderError('No SMS gateway is configured (set SMS_PROVIDER).', { code: 'SMS_NOT_CONFIGURED' });
    return gw(args);
  },
};

module.exports = select({ sandbox, live });
