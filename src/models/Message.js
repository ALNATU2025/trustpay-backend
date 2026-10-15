'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
    from: { type: String, enum: ['user', 'agent'], required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    text: { type: String, required: true, maxlength: 2000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ ticket: 1, createdAt: 1, _id: 1 });

module.exports = mongoose.model('Message', schema);
