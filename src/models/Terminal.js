'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    code: { type: String, required: true }, // TP-2048
    serial: { type: String, required: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    businessName: String,
    location: String,
    connection: { type: String, default: '' },
    battery: { type: Number, default: null },
    lastSyncAt: Date,
    request: { type: mongoose.Schema.Types.ObjectId, ref: 'TerminalRequest' },
  },
  { timestamps: true },
);
schema.index({ code: 1 }, { unique: true });
schema.index({ serial: 1 }, { unique: true });
schema.index({ owner: 1 }, { unique: true }); // one terminal per merchant

module.exports = mongoose.model('Terminal', schema);
