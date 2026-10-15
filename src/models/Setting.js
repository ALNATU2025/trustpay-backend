'use strict';
const mongoose = require('mongoose');

/** Small key/value store for admin-editable settings (e.g. tier limits). */
const schema = new mongoose.Schema({ key: { type: String, required: true }, value: mongoose.Schema.Types.Mixed }, { timestamps: true, minimize: false });
schema.index({ key: 1 }, { unique: true });

module.exports = mongoose.model('Setting', schema);
