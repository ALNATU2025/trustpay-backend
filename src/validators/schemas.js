'use strict';
/**
 * zod schemas for every request body/query. Money fields are parsed to INTEGER MINOR UNITS:
 * a field named `amount` in a schema's OUTPUT is already minor units (Le x 100).
 * Strings are trimmed; phone numbers are normalised to the stored 8-digit form.
 */
const { z } = require('zod');
const { normalisePhone } = require('../utils/phone');
const { toMinor } = require('../utils/money');

const req = (name) => ({ required_error: `${name} is required.`, invalid_type_error: `${name} is not valid.` });

const text = (name, { min = 1, max = 120 } = {}) =>
  z.string(req(name)).trim().min(min, `${name} is required.`).max(max, `${name} is too long.`);

const optText = (name, max = 240) =>
  z
    .string(req(name))
    .trim()
    .max(max, `${name} is too long.`)
    .nullish()
    .transform((v) => (v ? v : undefined));

const digits = (name, re, msg) => z.string(req(name)).trim().regex(re, msg || `${name} is not valid.`);

const phone = (name = 'Phone number') =>
  z.union([z.string(), z.number()], req(name)).transform((v, ctx) => {
    const p = normalisePhone(v);
    if (!p) {
      ctx.addIssue({ code: 'custom', message: `Enter a valid Sierra Leone ${name.toLowerCase()}.` });
      return z.NEVER;
    }
    return p;
  });

const email = z.string(req('Email')).trim().toLowerCase().max(254, 'Email is too long.').email('Enter a valid email address.');

const password = z
  .string(req('Password'))
  .min(8, 'Password must be at least 8 characters.')
  .max(72, 'Password must be at most 72 characters.')
  .superRefine((v, ctx) => {
    if (!/\d/.test(v)) ctx.addIssue({ code: 'custom', message: 'Password must include a number.' });
    else if (!/[^A-Za-z0-9\s]/.test(v)) ctx.addIssue({ code: 'custom', message: 'Password must include a symbol.' });
  });

const pin = z.string(req('PIN')).regex(/^\d{4}$/, 'PIN must be 4 digits.');
const otpCode = z.union([z.string(), z.number()], req('Code')).transform((v) => String(v).trim()).pipe(z.string().regex(/^\d{6}$/, 'Code must be 6 digits.'));

const amount = (opts) =>
  z.any().transform((v, ctx) => {
    try {
      return toMinor(v, opts);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e.message });
      return z.NEVER;
    }
  });

const bool = (name) => z.boolean(req(name));
const note = optText('Note', 100);
const idStr = (name) => text(name, { max: 64 });
const accountNumber10 = digits('Account number', /^\d{10}$/, 'Account number must be 10 digits.');
const bankAccount = digits('Account number', /^\d{6,20}$/, 'Enter a valid account number.');

const page = z.coerce.number().int().min(1, 'Page must be 1 or more.').default(1);
const limit = z.coerce.number().int().min(1).max(50, 'Limit can be at most 50.').default(20);
const q = z.string().trim().max(80).optional();
const isoDate = (name) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({ code: 'custom', message: `${name} must be a valid date.` });
        return z.NEVER;
      }
      return d;
    });

const ID_TYPES = ['NIN', 'Passport', 'Driver’s licence', 'Voter ID'];

const S = {
  /* ---- auth ---- */
  register: z.object({
    firstName: text('First name', { max: 60 }),
    lastName: text('Last name', { max: 60 }),
    email,
    phone: phone(),
    password,
  }),
  otpVerify: z.object({ code: otpCode }),
  identity: z.object({
    legalName: text('Legal name', { min: 2, max: 120 }),
    dob: z
      .string(req('Date of birth'))
      .trim()
      .transform((v, ctx) => {
        const d = new Date(v);
        const now = new Date();
        const eighteen = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
        if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1900) {
          ctx.addIssue({ code: 'custom', message: 'Enter a valid date of birth.' });
          return z.NEVER;
        }
        if (d > eighteen) {
          ctx.addIssue({ code: 'custom', message: 'You must be at least 18 years old.' });
          return z.NEVER;
        }
        return d;
      }),
    idType: z.enum(ID_TYPES, { errorMap: () => ({ message: 'Choose a valid ID type.' }) }),
    idNumber: text('ID number', { min: 4, max: 40 }),
    address: text('Address', { min: 5, max: 240 }),
  }),
  setPin: z.object({ pin }),
  login: z.object({ identifier: text('Email or phone number', { max: 254 }), password: z.string(req('Password')).min(1, 'Password is required.').max(200) }),
  forgot: z.object({ identifier: text('Email or phone number', { max: 254 }) }),
  forgotVerify: z.object({ identifier: text('Email or phone number', { max: 254 }), code: otpCode }),
  reset: z.object({ resetToken: z.string(req('Reset token')).min(10).max(2000), password }),

  /* ---- me ---- */
  mePatch: z.object({
    firstName: text('First name', { max: 60 }).optional(),
    lastName: text('Last name', { max: 60 }).optional(),
    email: email.optional(),
    address: z.string().trim().max(240).optional(),
    businessName: z.string().trim().max(120).optional(),
  }),
  mePassword: z.object({ currentPassword: z.string(req('Current password')).min(1).max(200), newPassword: password }),
  mePin: z.object({ currentPin: pin, newPin: pin }),
  mePinVerify: z.object({ pin }),
  limitRequest: z.object({ reason: optText('Reason', 300) }),

  /* ---- lookups ---- */
  lookupBank: z.object({ bank: text('Bank'), accountNumber: bankAccount }),
  lookupMeter: z.object({ provider: text('Provider'), meter: digits('Meter number', /^\d{6,20}$/, 'Enter a valid meter or account number.') }),
  lookupUser: z
    .object({ accountNumber: accountNumber10.optional(), phone: phone().optional() })
    .refine((v) => v.accountNumber || v.phone, { message: 'Provide an account number or phone number.' }),
  lookupCustomer: z.object({
    category: z.enum(['tv', 'internet'], { errorMap: () => ({ message: 'Category must be tv or internet.' }) }),
    provider: text('Provider'),
    number: digits('Account number', /^\d{6,20}$/, 'Enter a valid account number.'),
  }),
  lookupWallet: z.object({ provider: text('Wallet provider'), number: phone('Wallet number') }),

  /* ---- payments ---- */
  transferBank: z.object({
    bank: text('Bank'),
    accountNumber: bankAccount,
    accountName: optText('Account name', 120),
    amount: amount(),
    note,
    pin,
    saveRecipient: z.boolean().optional(),
  }),
  transferUser: z.object({ accountNumber: accountNumber10, amount: amount(), note, pin }),
  mmSend: z.object({ provider: text('Wallet provider'), number: phone('Wallet number'), amount: amount(), pin }),
  mmAdd: z.object({ provider: text('Wallet provider'), number: phone('Wallet number'), amount: amount(), code: otpCode }),
  fundingCard: z.object({ amount: amount(), cardLast4: digits('Card last 4', /^\d{4}$/, 'Card last 4 must be 4 digits.'), brand: text('Card brand', { max: 30 }) }),
  bills: z.object({
    category: z.enum(['electricity', 'tv', 'internet'], { errorMap: () => ({ message: 'Category must be electricity, tv or internet.' }) }),
    provider: text('Provider'),
    prepaid: z.boolean().optional(),
    meter: digits('Meter number', /^\d{6,20}$/, 'Enter a valid meter or account number.'),
    customer: optText('Customer', 120),
    amount: amount(),
    phone: phone('Phone number'),
    pin,
  }),
  airtime: z.object({ network: text('Network'), phone: phone('Phone number'), amount: amount(), pin }),
  data: z.object({ network: text('Network'), phone: phone('Phone number'), planId: idStr('Plan'), pin }),
  subscription: z.object({
    category: z.enum(['tv', 'internet'], { errorMap: () => ({ message: 'Category must be tv or internet.' }) }),
    provider: text('Provider'),
    accountNumber: digits('Account number', /^\d{6,20}$/, 'Enter a valid account number.'),
    packageId: idStr('Package'),
    phone: phone('Phone number'),
    pin,
  }),

  /* ---- webhooks ---- */
  webhookFunding: z.object({
    accountNumber: accountNumber10,
    amount: amount({ max: Number.MAX_SAFE_INTEGER }), // money the bank already took must always be creditable
    reference: z.string(req('Reference')).trim().regex(/^[A-Za-z0-9._:-]{6,64}$/, 'Reference must be 6-64 letters, numbers or . _ : -'),
    sender: optText('Sender', 80),
  }),
  webhookPos: z.object({
    terminalCode: z.string(req('Terminal code')).trim().regex(/^TP-\d{4}$/, 'Terminal code is not valid.'),
    amount: amount({ max: Number.MAX_SAFE_INTEGER }),
    kind: z.enum(['card', 'transfer'], { errorMap: () => ({ message: 'Kind must be card or transfer.' }) }),
    payer: optText('Payer', 80),
    reference: z.string(req('Reference')).trim().regex(/^[A-Za-z0-9._:-]{4,64}$/, 'Reference is not valid.'),
    battery: z.number().int().min(0).max(100).optional(),
    connection: optText('Connection', 30),
  }),

  /* ---- cards ---- */
  cardVirtual: z.object({ amount: amount({ allowZero: true }), pin }),
  cardDetails: z.object({ pin }),
  cardFreeze: z.object({ frozen: bool('Frozen') }),
  cardFund: z.object({ amount: amount(), pin }),
  cardPhysical: z.object({
    name: text('Name on card', { max: 60 }),
    phone: phone('Phone number'),
    address: text('Address', { max: 240 }),
    city: text('City', { max: 80 }),
    state: text('State', { max: 80 }),
    pin,
  }),

  /* ---- POS ---- */
  posToggle: z.object({ enabled: bool('Enabled') }),
  posRequest: z.object({
    businessName: text('Business name', { max: 120 }),
    category: text('Category', { max: 80 }),
    address: text('Address', { max: 240 }),
    city: text('City', { max: 80 }),
    state: text('State', { max: 80 }),
    contact: phone('Contact number'),
    pin,
  }),

  /* ---- support ---- */
  ticketCreate: z.object({ topic: text('Topic', { max: 60 }), message: text('Message', { max: 2000 }) }),
  message: z.object({ text: text('Message', { max: 2000 }) }),

  /* ---- admin ---- */
  adminUserPatch: z.object({
    status: z.enum(['active', 'suspended'], { errorMap: () => ({ message: 'Status must be active or suspended.' }) }).optional(),
    tier: z.enum(['Tier 1 · Basic', 'Tier 2 · Verified', 'Tier 3 · Premium']).optional(),
  }).refine((v) => v.status || v.tier, { message: 'Nothing to update.' }),
  decision: z.object({ approve: bool('Approve'), reason: optText('Reason', 300) }),

  /* ---- queries ---- */
  listQuery: z.object({ q, page, limit }),
  txnQuery: z.object({
    service: z.enum(['all', 'transfer', 'bill', 'airtime', 'funding']).default('all'),
    status: z
      .string()
      .trim()
      .optional()
      .transform((v, ctx) => {
        if (!v) return undefined;
        const m = { successful: 'Successful', pending: 'Pending', failed: 'Failed' }[v.toLowerCase()];
        if (!m) {
          ctx.addIssue({ code: 'custom', message: 'Status must be Successful, Pending or Failed.' });
          return z.NEVER;
        }
        return m;
      }),
    q,
    page,
    limit,
    from: isoDate('From'),
    to: isoDate('To'),
  }),
  adminTicketsQuery: z.object({
    status: z.enum(['open', 'closed']).optional(),
    type: z.enum(['ticket', 'chat']).optional(),
    page,
    limit,
  }),
};

module.exports = S;
