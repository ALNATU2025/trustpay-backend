'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reference: { type: String, required: true },
    grossMinor: { type: Number, required: true },
    feeMinor: { type: Number, required: true },
    netMinor: { type: Number, required: true },
    count: { type: Number, required: true },
    scheduledFor: Date,
    status: { type: String, enum: ['Processing', 'Paid'], default: 'Processing' },
    settledAt: Date,
    destination: { type: String, default: 'TrustPay wallet' },
    sweepStarted: { type: Boolean, default: false }, // bank payout attempted (never twice)
  },
  { timestamps: true },
);
schema.index({ reference: 1 }, { unique: true });
schema.index({ owner: 1, createdAt: -1 });
schema.index({ status: 1 });

module.exports = mongoose.model('Settlement', schema);
