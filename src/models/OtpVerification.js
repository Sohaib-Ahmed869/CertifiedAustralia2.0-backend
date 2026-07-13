const mongoose = require('mongoose');

/**
 * OtpVerification — Mongo-backed OTP store (horizontally safe, unlike an
 * in-memory cache). One doc per issued code, keyed by an opaque verificationId.
 * The code itself is stored SHA-256 hashed, single-use, attempt-capped, TTL'd,
 * and bound to a purpose so a code cannot cross flows.
 */
const otpVerificationSchema = new mongoose.Schema(
  {
    verificationId: { type: String, required: true, unique: true, index: true },
    purpose: { type: String, required: true }, // e.g. 'registration'
    channel: { type: String, enum: ['email', 'sms'], required: true },
    destination: { type: String, default: null }, // email or phone (audit/display)
    otpHash: { type: String, required: true }, // sha256(code)
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    consumedAt: { type: Date, default: null },
    meta: { type: Object, default: {} },
    // TTL — Mongo removes the doc at expiresAt.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

module.exports = mongoose.model('OtpVerification', otpVerificationSchema);
