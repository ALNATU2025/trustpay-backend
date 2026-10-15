'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reference: { type: String, required: true },
    type: { type: String, enum: ['ticket', 'chat'], default: 'ticket' },
    topic: { type: String, required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    lastMessage: { _id: false, from: String, text: String, createdAt: Date },
    lastMessageAt: { type: Date, default: Date.now },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
schema.index({ reference: 1 }, { unique: true });
schema.index({ user: 1, type: 1, lastMessageAt: -1 });
schema.index({ status: 1, lastMessageAt: -1 });
// One open live-chat ticket per user.
schema.index({ user: 1 }, { unique: true, partialFilterExpression: { type: 'chat', status: 'open' }, name: 'one_open_chat_per_user' });

module.exports = mongoose.model('Ticket', schema);
