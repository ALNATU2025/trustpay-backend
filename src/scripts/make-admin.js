'use strict';
// Usage: node src/scripts/make-admin.js <userId|phone8> [admin|support|user]
const mongoose = require('mongoose');
const env = require('../config/env');
const { User } = require('../models');

(async () => {
  const [who, role = 'admin'] = process.argv.slice(2);
  if (!who || !['admin', 'support', 'user'].includes(role)) {
    console.error('Usage: node src/scripts/make-admin.js <userId|8-digit phone> [admin|support|user]');
    process.exit(1);
  }
  await mongoose.connect(env.mongoUri);
  const q = /^[0-9a-f]{24}$/i.test(who) ? { _id: who } : { phone: who };
  const u = await User.findOneAndUpdate(q, { $set: { role } }, { new: true });
  console.log(u ? `${u.fullName || u._id} is now ${u.role}` : 'No such user');
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
