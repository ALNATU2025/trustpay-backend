'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    terminal: { type: mongoose.Schema.Types.ObjectId, ref: 'Terminal', required: true },
    terminalCode: { type: String, required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    kind: { type: String, enum: ['card', 'transfer'], required: true },
    payer: String,
    reference: { type: String, required: true }, // provided by the POS/acquirer
    settled: { type: Boolean, default: false },
    settlement: { type: mongoose.Schema.Types.ObjectId, ref: 'Settlement', default: null },
  },
  { timestamps: true },
);
schema.index({ terminalCode: 1, reference: 1 }, { unique: true });
schema.index({ owner: 1, settled: 1, createdAt: 1 });
schema.index({ owner: 1, createdAt: -1 });
schema.index({ settlement: 1 });

module.exports = mongoose.model('PosPayment', schema);
