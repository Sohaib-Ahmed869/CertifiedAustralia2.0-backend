const mongoose = require('mongoose');

/**
 * GuardrailConfig — single-document control plane for the public-registration
 * anti-abuse guardrails. Read fresh per request so CEO toggle changes take
 * effect immediately (no redeploy). Fail-safe defaults live in
 * guardrailService.DEFAULTS; this doc overrides them.
 *
 * NOTE on defaults: guards ship OFF so a fresh deploy never locks anyone out
 * before the reCAPTCHA / Twilio / SMTP secrets are configured. The CEO enables
 * each guard from the dashboard once its keys are in place.
 */
const guardrailConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'default' },

    // Guard toggles
    captchaEnabled: { type: Boolean, default: false },
    emailOtpEnabled: { type: Boolean, default: false },
    smsOtpEnabled: { type: Boolean, default: false },

    // Per-IP rate limits (configurable thresholds)
    otpSendWindowMin: { type: Number, default: 15 },
    otpSendMax: { type: Number, default: 5 },
    createWindowMin: { type: Number, default: 60 },
    createMax: { type: Number, default: 15 },

    // Hourly volume alert
    hourlyAlertThreshold: { type: Number, default: 50 },
    alertEmails: { type: String, default: '' }, // comma-separated
    lastAlertAt: { type: Date, default: null },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('GuardrailConfig', guardrailConfigSchema);
