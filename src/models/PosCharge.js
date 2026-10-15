'use strict';
const mongoose = require('mongoose');

/** A request for payment a merchant makes from their phone (Monime USSD payment code). */
const schema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reference: { type: String, required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    note: String,
    customerPhone: { type: String, required: true },
    customerName: String,
    provider: String,
    providerRef: String,
    ussdCode: String,
    expiresAt: Date,
    status: { type: String, enum: ['Pending', 'Paid', 'Expired', 'Failed'], default: 'Pending' },
    failureReason: String,
    paidAt: Date,
  },
  { timestamps: true },
);
schema.index({ reference: 1 }, { unique: true });
schema.index({ owner: 1, createdAt: -1 });
schema.index({ providerRef: 1 }, { sparse: true });
schema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('PosCharge', schema);
