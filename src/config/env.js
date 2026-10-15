'use strict';
/**
 * Central, validated environment configuration.
 * Nothing here connects to anything; `assertProductionReady()` is called by server.js.
 */
const crypto = require('crypto');
require('dotenv').config();

const str = (v, d = '') => (v === undefined || v === null || String(v).trim() === '' ? d : String(v).trim());
const bool = (v, d = false) =>
  v === undefined || String(v).trim() === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const NODE_ENV = str(process.env.NODE_ENV, 'development');
const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

const warnings = [];

let jwtSecret = str(process.env.JWT_SECRET);
if (!jwtSecret) {
  jwtSecret = crypto.randomBytes(48).toString('hex');
  warnings.push('JWT_SECRET is not set: using a random ephemeral secret (all sessions end on restart).');
}

let cardKeyHex = str(process.env.CARD_ENCRYPTION_KEY);
if (!cardKeyHex) {
  // Deterministic non-production key so dev data survives restarts. NEVER used in production
  // (assertProductionReady refuses to start without a real key).
  cardKeyHex = crypto.createHash('sha256').update('trustpay-dev-only-card-key').digest('hex');
  warnings.push('CARD_ENCRYPTION_KEY is not set: using an insecure development key.');
}

let webhookSecret = str(process.env.WEBHOOK_SECRET);
if (!webhookSecret) {
  webhookSecret = crypto.randomBytes(32).toString('hex');
  warnings.push('WEBHOOK_SECRET is not set: webhooks cannot be signed by any partner until you set it.');
}

const providerMode = str(process.env.PROVIDER_MODE, 'sandbox').toLowerCase();

const env = {
  NODE_ENV,
  isProd,
  isTest,
  port: int(process.env.PORT, 3000),
  mongoUri: str(process.env.MONGODB_URI),
  jwtSecret,
  jwtExpiresIn: str(process.env.JWT_EXPIRES_IN, '30d'),
  cardKeyHex,
  webhookSecret,
  providerMode,
  // Mongo _ids (comma separated) that always get full admin access. Defaults to the TrustPay owner account.
  superAdminIds: str(process.env.SUPER_ADMIN_IDS, '6ad0e47586522f7476ca3775').split(',').map((x) => x.trim()).filter(Boolean),
  otpDebug: bool(process.env.OTP_DEBUG, false),
  // Monime (https://docs.monime.io): payouts to banks / mobile money and hosted checkout (card, bank, mobile money).
  monime: {
    baseUrl: str(process.env.MONIME_BASE_URL, 'https://api.monime.io').replace(/\/+$/, ''),
    token: str(process.env.MONIME_ACCESS_TOKEN),
    spaceId: str(process.env.MONIME_SPACE_ID),
    version: str(process.env.MONIME_VERSION, 'caph.2025-08-23'),
    country: str(process.env.MONIME_COUNTRY, 'SL'),
    // Optional: settle payouts from a specific financial account (default: the Space's main account).
    payoutAccountId: str(process.env.MONIME_PAYOUT_ACCOUNT_ID),
    // Financial account that receives top-ups (payment codes). Empty = the space's main account.
    fundingAccountId: str(process.env.MONIME_FUNDING_ACCOUNT_ID),
    // HS256 secret you give Monime when you register the webhook (32-256 characters).
    webhookSecret: str(process.env.MONIME_WEBHOOK_SECRET),
    timeoutMs: int(process.env.MONIME_TIMEOUT_MS, 10000),
  },
  // Public URL of this API (used for checkout return pages), e.g. https://trustpay-backend-zkiv.onrender.com
  publicUrl: str(process.env.PUBLIC_URL, str(process.env.RENDER_EXTERNAL_URL)).replace(/\/+$/, ''),
  kycManual: bool(process.env.KYC_MANUAL, true),
  corsOrigins: str(process.env.CORS_ORIGINS, '*'),
  trustProxy: int(process.env.TRUST_PROXY, 1),
  bcryptCost: int(process.env.BCRYPT_COST, 12),
  maxAmountMinor: Math.round(Number(str(process.env.MAX_AMOUNT_LE, '1000000')) * 100),
  settlementFeeBps: int(process.env.SETTLEMENT_FEE_BPS, 40), // 0.4 %
  autoIndex: bool(process.env.AUTO_INDEX, true),
  admin: {
    email: str(process.env.ADMIN_EMAIL).toLowerCase(),
    phone: str(process.env.ADMIN_PHONE),
    password: str(process.env.ADMIN_PASSWORD),
    firstName: str(process.env.ADMIN_FIRST_NAME, 'TrustPay'),
    lastName: str(process.env.ADMIN_LAST_NAME, 'Admin'),
  },
  warnings,
};
if (env.otpDebug) warnings.push('OTP_DEBUG=true: sign-up and reset codes are returned in API responses (sandbox testing only).');

/** Throws with a readable list if the process is not safe to start. */
env.assertValid = function assertValid() {
  const problems = [];
  if (!['sandbox', 'live'].includes(env.providerMode)) problems.push('PROVIDER_MODE must be "sandbox" or "live".');
  if (!env.mongoUri) problems.push('MONGODB_URI is required.');
  if (!/^[0-9a-fA-F]{64}$/.test(env.cardKeyHex)) problems.push('CARD_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  if (!Number.isFinite(env.maxAmountMinor) || env.maxAmountMinor <= 0) problems.push('MAX_AMOUNT_LE must be a positive number.');
  if (env.providerMode === 'live') {
    if (!env.monime.token) problems.push('MONIME_ACCESS_TOKEN is required when PROVIDER_MODE=live.');
    if (!/^spc-/.test(env.monime.spaceId)) problems.push('MONIME_SPACE_ID (starts with "spc-") is required when PROVIDER_MODE=live.');
    if (env.monime.webhookSecret && (env.monime.webhookSecret.length < 32 || env.monime.webhookSecret.length > 256)) {
      problems.push('MONIME_WEBHOOK_SECRET must be 32-256 characters.');
    }
  }
  if (env.otpDebug && env.providerMode === 'live') problems.push('OTP_DEBUG must be false when PROVIDER_MODE=live.');
  if (isProd && env.providerMode === 'sandbox' && !bool(process.env.ALLOW_SANDBOX_IN_PRODUCTION, false)) {
    problems.push('PROVIDER_MODE=sandbox moves FAKE money and sends no SMS. For a public test deployment set ALLOW_SANDBOX_IN_PRODUCTION=true; for real users set PROVIDER_MODE=live.');
  }
  if (isProd) {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) problems.push('JWT_SECRET (32+ chars) is required in production.');
    if (!process.env.CARD_ENCRYPTION_KEY) problems.push('CARD_ENCRYPTION_KEY is required in production.');
    if (!process.env.WEBHOOK_SECRET || process.env.WEBHOOK_SECRET.length < 16) problems.push('WEBHOOK_SECRET (16+ chars) is required in production.');
    if (env.bcryptCost < 10) problems.push('BCRYPT_COST must be at least 10 in production.');
  }
  if (problems.length) {
    const err = new Error(`Invalid environment configuration:\n - ${problems.join('\n - ')}`);
    err.code = 'INVALID_ENV';
    throw err;
  }
};

module.exports = env;
