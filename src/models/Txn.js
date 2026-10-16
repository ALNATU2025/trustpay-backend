'use strict';
const mongoose = require('mongoose');

const txnSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reference: { type: String, required: true },
    kind: {
      type: String,
      required: true,
      enum: ['transfer', 'funding', 'bill', 'airtime', 'data', 'tv', 'internet', 'card', 'pos', 'mobile_money', 'agent'],
    },
    // Drives title/meta/receipt rendering (see services/presenter.js).
    subtype: { type: String, required: true },
    direction: { type: String, enum: ['debit', 'credit'], required: true },
    // amountMinor: the principal. feeMinor: fee. totalMinor: what actually moved on the wallet
    // (debit: amount + fee; credit: amount).
    amountMinor: { type: Number, required: true, min: 0 },
    feeMinor: { type: Number, default: 0, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['Successful', 'Pending', 'Failed'], default: 'Pending' },
    failureReason: String,
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ownerName: String,
    ownerAccount: String,
    search: String,
    balanceAfterMinor: Number,
    // Debit entries: true once the wallet debit has been applied (used to find stuck transactions).
    debited: { type: Boolean, default: false },
    providerRef: String,
    token: String,
    // Unique key for externally-keyed or system-keyed entries (webhook reference, reversal, settlement).
    externalRef: String,
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Txn' },
    isReversal: { type: Boolean, default: false },
    needsReview: { type: Boolean, default: false },
  },
  { timestamps: true },
);

txnSchema.index({ reference: 1 }, { unique: true });
txnSchema.index({ externalRef: 1 }, { unique: true, partialFilterExpression: { externalRef: { $type: 'string' } } });
txnSchema.index({ user: 1, createdAt: -1, _id: -1 });
txnSchema.index({ user: 1, kind: 1, createdAt: -1 });
txnSchema.index({ createdAt: -1 });
txnSchema.index({ direction: 1, status: 1, createdAt: -1 });
txnSchema.index({ status: 1, needsReview: 1 });

module.exports = mongoose.model('Txn', txnSchema);
