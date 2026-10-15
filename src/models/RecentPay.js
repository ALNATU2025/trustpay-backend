'use strict';
const mongoose = require('mongoose');

/** Fingerprint of a payment made in the last 2 minutes, used to catch accidental duplicates. */
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true },
  fp: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 120 },
});
schema.index({ user: 1, fp: 1 }, { unique: true });

module.exports = mongoose.model('RecentPay', schema);
