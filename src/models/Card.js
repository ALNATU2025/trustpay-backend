'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['virtual', 'physical'], required: true },
    panEnc: { type: String, select: false }, // AES-256-GCM
    cvvEnc: { type: String, select: false }, // AES-256-GCM
    last4: { type: String, default: '' }, // physical cards get theirs when shipped
    expiryMonth: { type: Number },
    expiryYear: { type: Number },
    holder: { type: String, required: true },
    balanceMinor: { type: Number, default: 0, min: 0 },
    frozen: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'frozen', 'pending', 'blocked'], default: 'active' },
    issuancePaidMinor: { type: Number, default: 0, min: 0 },
    providerRef: String,
    requestReference: String,
  },
  { timestamps: true },
);
// One virtual card per user.
schema.index({ user: 1, type: 1 }, { unique: true, partialFilterExpression: { type: 'virtual' } });
schema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Card', schema);
