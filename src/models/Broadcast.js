'use strict';
const mongoose = require('mongoose');

/** History of notifications an admin sent to a group of customers. */
const schema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, default: 'update' },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    audience: { type: String, enum: ['all', 'tier', 'merchants', 'user'], required: true },
    tier: String,
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    count: { type: Number, default: 0 },
  },
  { timestamps: true },
);
schema.index({ createdAt: -1 });

module.exports = mongoose.model('Broadcast', schema);
