'use strict';
const mongoose = require('mongoose');

/** Generic approval request (currently: transaction-limit / tier upgrade). KYC and POS approvals live on their own records. */
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['limit'], default: 'limit' },
    title: { type: String, required: true },
    detail: { type: String, default: '' },
    requestedTier: { type: String, default: 'Tier 3 · Premium' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reason: String,
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
  },
  { timestamps: true },
);
schema.index({ status: 1, createdAt: 1 });
schema.index({ user: 1 }, { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_per_user' });

module.exports = mongoose.model('Approval', schema);
