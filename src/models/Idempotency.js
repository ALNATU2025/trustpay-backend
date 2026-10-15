'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, required: true },
    key: { type: String, required: true },
    route: { type: String, required: true },
    requestHash: { type: String, required: true },
    state: { type: String, enum: ['processing', 'done'], default: 'processing' },
    statusCode: Number,
    response: mongoose.Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

schema.index({ user: 1, key: 1 }, { unique: true });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 }); // keys live 24h

module.exports = mongoose.model('Idempotency', schema);
