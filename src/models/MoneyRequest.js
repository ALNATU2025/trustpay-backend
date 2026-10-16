'use strict';
const mongoose = require('mongoose');

/**
 * "Pay me" request. `payer` is set when it was sent to one TrustPay customer; empty means it is an open
 * payment link that any TrustPay customer can pay by opening the link or typing its code.
 */
const schema = new mongoose.Schema(
  {
    requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    payer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    amountMinor: { type: Number, required: true, min: 1 },
    note: { type: String, default: '', maxlength: 140 },
    code: { type: String, required: true },
    status: { type: String, enum: ['pending', 'paid', 'declined', 'cancelled', 'expired'], default: 'pending' },
    expiresAt: { type: Date, required: true },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    paidAt: Date,
    paidReference: String,
  },
  { timestamps: true },
);
schema.index({ code: 1 }, { unique: true });
schema.index({ requester: 1, createdAt: -1 });
schema.index({ payer: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('MoneyRequest', schema);
