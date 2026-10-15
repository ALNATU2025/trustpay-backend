'use strict';
const mongoose = require('mongoose');

/** An uploaded proof document (utility bill, business registration). Small images/PDFs only. */
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['address_proof', 'business_document'], required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true, select: false },
  },
  { timestamps: true },
);
schema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Document', schema);
