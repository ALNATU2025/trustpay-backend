'use strict';
const mongoose = require('mongoose');

/** One notification in a customer's (or admin's) inbox. */
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, default: 'update' },
    title: { type: String, required: true, maxlength: 120 },
    body: { type: String, default: '', maxlength: 600 },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: Date,
    createdAt: { type: Date, default: Date.now, expires: 90 * 24 * 3600 },
  },
  { minimize: false },
);
schema.index({ user: 1, createdAt: -1 });
schema.index({ user: 1, readAt: 1 });

module.exports = mongoose.model('Notification', schema);
