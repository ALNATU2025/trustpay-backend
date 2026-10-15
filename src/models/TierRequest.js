'use strict';
const mongoose = require('mongoose');

/** A customer's request to move up a tier, with the proof they supplied. */
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tier: { type: String, enum: ['Tier 2 · Verified', 'Tier 3 · Premium'], required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    address: String, // tier 2: the address on the bill
    legalName: String, // tier 3
    businessNumber: String, // tier 3
    document: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
    reason: String,
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
  },
  { timestamps: true },
);
schema.index({ status: 1, createdAt: 1 });
schema.index({ user: 1, createdAt: -1 });
schema.index({ user: 1 }, { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_tier_request' });

module.exports = mongoose.model('TierRequest', schema);
