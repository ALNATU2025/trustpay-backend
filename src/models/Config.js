'use strict';
const mongoose = require('mongoose');

const named = { _id: false, name: String, subtitle: String };
const pkg = { _id: false, id: String, name: String, detail: String, priceMinor: Number };

const schema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    banks: [String],
    mobileMoney: [String],
    networks: [String],
    electricity: [named],
    tv: [named],
    internet: [named],
    dataPlans: [{ _id: false, id: String, size: String, days: Number, priceMinor: Number }],
    tvPackages: [pkg],
    internetPackages: [pkg],
    feesMinor: { type: mongoose.Schema.Types.Mixed },
    feeRatesBps: { type: mongoose.Schema.Types.Mixed },
    terminal: { categories: [String], districts: [String] },
    topics: [String],
    support: { phone: String, email: String, hours: String },
  },
  { timestamps: true, minimize: false },
);
schema.index({ key: 1 }, { unique: true });

module.exports = mongoose.model('Config', schema);
