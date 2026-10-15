'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    bank: { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true },
  },
  { timestamps: true },
);
schema.index({ user: 1, bank: 1, accountNumber: 1 }, { unique: true });
schema.index({ user: 1, updatedAt: -1 });

module.exports = mongoose.model('Recipient', schema);
