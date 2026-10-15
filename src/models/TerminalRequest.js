'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reference: { type: String, required: true }, // same as the charge txn reference
    businessName: { type: String, required: true },
    category: String,
    address: String,
    city: String,
    state: String,
    contact: String,
    depositMinor: { type: Number, required: true },
    deliveryMinor: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reason: String,
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    refundedAt: Date,
    terminal: { type: mongoose.Schema.Types.ObjectId, ref: 'Terminal' },
  },
  { timestamps: true },
);
schema.index({ reference: 1 }, { unique: true });
schema.index({ user: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: 1 });
// At most one pending request per user.
schema.index({ user: 1 }, { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_per_user' });

module.exports = mongoose.model('TerminalRequest', schema);
