'use strict';
const mongoose = require('mongoose');

const TIERS = ['Tier 1 · Basic', 'Tier 2 · Verified', 'Tier 3 · Premium'];

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, maxlength: 60 },
    searchName: { type: String, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, required: true }, // normalised 8 national digits (see utils/phone.js)
    passwordHash: { type: String, required: true, select: false },
    pinHash: { type: String, select: false },
    hasPin: { type: Boolean, default: false },
    accountNumber: { type: String, required: true },
    businessName: { type: String, default: '', trim: true, maxlength: 120 },
    // Permanent code a merchant shares/prints (as text or QR) so customers can pay them. 6 digits.
    merchantCode: { type: String },
    address: { type: String, default: '', trim: true, maxlength: 240 },

    role: { type: String, enum: ['user', 'admin', 'support'], default: 'user' },
    status: { type: String, enum: ['active', 'suspended', 'pending_kyc'], default: 'pending_kyc' },
    tier: { type: String, enum: TIERS, default: TIERS[0] },
    onboardingStep: { type: String, enum: ['phone', 'identity', 'pin', 'done'], default: 'phone' },
    phoneVerified: { type: Boolean, default: false },

    // Identity / KYC (the raw ID number is never stored)
    legalName: String,
    dob: Date,
    idType: { type: String, enum: ['NIN', 'Passport', 'Driver’s licence', 'Voter ID'] },
    idNumberHash: { type: String, select: false },
    idLast4: String,
    kycStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
    kycReason: String,
    kycSubmittedAt: Date,

    // Money: integer minor units, never negative.
    balanceMinor: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'balanceMinor must be an integer' },
    },
    // Idempotency keys of credits already applied (last 100), so a credit is applied exactly once.
    appliedCredits: { type: [String], select: false, default: undefined },

    // Security state
    tokenVersion: { type: Number, default: 0 },
    loginFailCount: { type: Number, default: 0 },
    loginLockedUntil: Date,
    pinFailCount: { type: Number, default: 0 },
    pinLockedUntil: Date,
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ phone: 1 }, { unique: true });
userSchema.index({ accountNumber: 1 }, { unique: true });
userSchema.index({ merchantCode: 1 }, { unique: true, partialFilterExpression: { merchantCode: { $type: 'string' } } });
userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ onboardingStep: 1, kycStatus: 1, createdAt: 1 });
userSchema.index({ lastLoginAt: -1 });

userSchema.virtual('fullName').get(function fullName() {
  return `${this.firstName} ${this.lastName}`.trim();
});

userSchema.pre('validate', function setSearch(next) {
  this.searchName = `${this.firstName} ${this.lastName}`.toLowerCase();
  next();
});

module.exports = mongoose.model('User', userSchema);
module.exports.TIERS = TIERS;
