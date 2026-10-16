'use strict';
const mongoose = require('mongoose');

/** Sign-ins and security changes on an account, shown to the owner under Security. Kept 180 days. */
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true }, // login | new_device | pin_changed | pin_reset | password_changed | sessions_revoked
    ip: String,
    device: String,
    note: { type: String, maxlength: 200 },
    createdAt: { type: Date, default: Date.now, expires: 180 * 24 * 3600 },
  },
  { minimize: false },
);
schema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('SecurityEvent', schema);
