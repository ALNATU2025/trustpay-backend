'use strict';
/**
 * npm run seed
 * Upserts the catalog/pricing Config document and, when ADMIN_* variables are set, the first admin.
 * It never creates fake customers or transactions.
 */
const env = require('../config/env');
const { connect, disconnect } = require('../db');
const { User, Config } = require('../models');
const defaults = require('../config/defaults');
const { normalisePhone } = require('../utils/phone');
const { hashSecret, randomDigits } = require('../utils/crypto');

async function main() {
  env.assertValid();
  await connect();

  await Config.updateOne({ key: 'app' }, { $set: { ...defaults, key: 'app' } }, { upsert: true });
  console.log('Catalog config saved (key "app").');

  const a = env.admin;
  if (a.email && a.phone && a.password) {
    const phone = normalisePhone(a.phone);
    if (!phone) throw new Error('ADMIN_PHONE is not a valid Sierra Leone number.');
    if (a.password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
    const existing = await User.findOne({ $or: [{ email: a.email }, { phone }] });
    if (existing) {
      if (existing.role !== 'admin') {
        existing.role = 'admin';
        await existing.save();
        console.log(`Promoted existing user ${existing.email} to admin.`);
      } else {
        console.log('Admin already exists. Nothing changed.');
      }
    } else {
      await User.create({
        firstName: a.firstName,
        lastName: a.lastName,
        email: a.email,
        phone,
        passwordHash: await hashSecret(a.password),
        accountNumber: `0${randomDigits(9)}`,
        role: 'admin',
        status: 'active',
        onboardingStep: 'done',
        phoneVerified: true,
        tier: 'Tier 3 · Premium',
      });
      console.log(`Admin created: ${a.email}. Sign in with the phone or email and ADMIN_PASSWORD, then remove ADMIN_PASSWORD from your environment.`);
    }
  } else {
    console.log('ADMIN_EMAIL / ADMIN_PHONE / ADMIN_PASSWORD not all set: no admin created.');
  }
  await disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
