const crypto = require('crypto');
const GuardrailConfig = require('../models/GuardrailConfig');
const OtpVerification = require('../models/OtpVerification');
const Application = require('../models/Application');
const AppError = require('../utils/AppError');
const { sendTemplatedEmail } = require('./emailService');
const smsService = require('./smsService');

/* ═══════════════════════════════════════════════════════
   CONFIG (fail-safe defaults; guards ship OFF — see model note)
   ═══════════════════════════════════════════════════════ */

const DEFAULTS = {
  captchaEnabled: false,
  emailOtpEnabled: false,
  smsOtpEnabled: false,
  otpSendWindowMin: 15,
  otpSendMax: 5,
  createWindowMin: 60,
  createMax: 15,
  hourlyAlertThreshold: 50,
  alertEmails: '',
};

const NUMBER_FIELDS = ['otpSendWindowMin', 'otpSendMax', 'createWindowMin', 'createMax', 'hourlyAlertThreshold'];
const BOOL_FIELDS = ['captchaEnabled', 'emailOtpEnabled', 'smsOtpEnabled'];

async function readConfig() {
  const doc = await GuardrailConfig.findOne({ key: 'default' }).lean();
  if (!doc) return { ...DEFAULTS };
  const merged = { ...DEFAULTS };
  [...BOOL_FIELDS, ...NUMBER_FIELDS, 'alertEmails'].forEach((k) => {
    if (doc[k] !== undefined && doc[k] !== null) merged[k] = doc[k];
  });
  merged.lastAlertAt = doc.lastAlertAt || null;
  merged.updatedAt = doc.updatedAt;
  return merged;
}

/** Only the booleans the public FE needs to decide which widgets to render. */
async function publicConfig() {
  const c = await readConfig();
  return {
    captchaEnabled: c.captchaEnabled,
    emailOtpEnabled: c.emailOtpEnabled,
    smsOtpEnabled: c.smsOtpEnabled,
  };
}

async function updateConfig(body = {}, userId) {
  const clean = {};
  BOOL_FIELDS.forEach((k) => { if (body[k] !== undefined) clean[k] = !!body[k]; });
  NUMBER_FIELDS.forEach((k) => {
    if (body[k] !== undefined && !isNaN(parseInt(body[k], 10))) {
      clean[k] = Math.max(0, parseInt(body[k], 10));
    }
  });
  if (body.alertEmails !== undefined) clean.alertEmails = String(body.alertEmails || '').trim();
  clean.updatedBy = userId || null;

  await GuardrailConfig.findOneAndUpdate(
    { key: 'default' },
    { $set: clean, $setOnInsert: { key: 'default' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return readConfig();
}

/* ═══════════════════════════════════════════════════════
   GUARD 1 — reCAPTCHA v2 (fail-closed)
   ═══════════════════════════════════════════════════════ */

async function verifyRecaptcha(token, ip) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  // Fail closed: a missing secret or an unreachable Google can never bypass.
  if (!secret || !token) return false;
  try {
    const params = new URLSearchParams({ secret, response: token });
    if (ip) params.append('remoteip', ip);
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('[guardrail] recaptcha verify error:', err.message);
    return false;
  }
}

/* ═══════════════════════════════════════════════════════
   GUARD 2 — OTP (email / SMS)
   ═══════════════════════════════════════════════════════ */

const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');
const genOtp = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const OTP_TTL_MS = 5 * 60 * 1000;

/** Create + persist a code and return { verificationId, otp } (otp for delivery only). */
async function issueOtp({ purpose, channel, destination, meta }) {
  const verificationId = crypto.randomUUID();
  const otp = genOtp();
  await OtpVerification.create({
    verificationId,
    purpose,
    channel,
    destination: destination || null,
    otpHash: hashOtp(otp),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    meta: meta || {},
  });
  return { verificationId, otp };
}

/** Issue + deliver an OTP over the requested (enabled) channel. */
async function sendOtp({ purpose = 'registration', channel, destination }) {
  const config = await readConfig();
  if (channel === 'email' && !config.emailOtpEnabled) throw new AppError('Email verification is not enabled', 400);
  if (channel === 'sms' && !config.smsOtpEnabled) throw new AppError('SMS verification is not enabled', 400);
  if (channel !== 'email' && channel !== 'sms') throw new AppError('Invalid verification channel', 400);
  if (!destination) throw new AppError(`A ${channel === 'sms' ? 'phone number' : 'email'} is required`, 400);

  const { verificationId, otp } = await issueOtp({ purpose, channel, destination });

  if (channel === 'email') {
    await sendTemplatedEmail({
      to: destination,
      subject: 'Your verification code — Certified Australia',
      preheader: `Your code is ${otp}. It expires in 5 minutes.`,
      templateContent: `
        <h2 style="margin:0 0 16px 0;font-size:20px;color:#111827;">Verify your email</h2>
        <p>Use the code below to complete your registration. It expires in <strong>5 minutes</strong>.</p>
        <p style="font-size:30px;font-weight:800;letter-spacing:8px;color:#0a9d42;margin:20px 0;">${otp}</p>
        <p style="font-size:13px;color:#6b7280;">If you didn't request this, you can ignore this email.</p>
      `,
    });
  } else {
    await smsService.sendSms(destination, `Your Certified Australia verification code is ${otp}. It expires in 5 minutes.`);
  }

  return {
    verificationId,
    expiresInSec: OTP_TTL_MS / 1000,
    ...(process.env.NODE_ENV === 'development' ? { devOtp: otp } : {}),
  };
}

/** Verify + consume a code. Typed errors; deletes on success. */
async function verifyAndConsume({ verificationId, otp, purpose, allowedChannels }) {
  if (!verificationId || !otp) throw new AppError('Verification code is required', 400);

  const doc = await OtpVerification.findOne({ verificationId });
  if (!doc || doc.consumedAt) throw new AppError('Verification expired or not found. Please request a new code.', 400);
  if (doc.purpose !== purpose) throw new AppError('Verification does not match this action.', 400);
  if (allowedChannels && !allowedChannels.includes(doc.channel)) {
    throw new AppError('This verification channel is not accepted.', 400);
  }
  if (doc.expiresAt.getTime() < Date.now()) {
    await OtpVerification.deleteOne({ _id: doc._id });
    throw new AppError('Verification code expired. Please request a new code.', 400);
  }
  if (doc.attempts >= doc.maxAttempts) {
    await OtpVerification.deleteOne({ _id: doc._id });
    throw new AppError('Too many incorrect attempts. Please request a new code.', 429);
  }

  if (doc.otpHash !== hashOtp(otp)) {
    doc.attempts += 1;
    await doc.save();
    throw new AppError('Incorrect verification code.', 400);
  }

  // Success — single use.
  await OtpVerification.deleteOne({ _id: doc._id });
  return { channel: doc.channel, destination: doc.destination };
}

/* ═══════════════════════════════════════════════════════
   GUARD 4 — Hourly volume alert (DB-backed; horizontally safe)
   ═══════════════════════════════════════════════════════ */

async function recordSubmissionAlert() {
  try {
    const config = await readConfig();
    const threshold = config.hourlyAlertThreshold;
    const emails = String(config.alertEmails || '')
      .split(',').map((e) => e.trim()).filter(Boolean);
    if (!threshold || threshold <= 0 || emails.length === 0) return;

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const count = await Application.countDocuments({ createdAt: { $gte: since } });
    if (count < threshold) return;

    // Cooldown: alert at most once/hour (guarded by an atomic update on lastAlertAt).
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const armed = await GuardrailConfig.findOneAndUpdate(
      { key: 'default', $or: [{ lastAlertAt: null }, { lastAlertAt: { $lte: cutoff } }] },
      { $set: { lastAlertAt: new Date() } },
      { new: true }
    );
    if (!armed) return; // another instance already alerted, or still in cooldown

    await sendTemplatedEmail({
      to: emails.join(','),
      subject: '⚠ High registration volume — Certified Australia',
      preheader: `${count} new applications in the last hour (threshold ${threshold}).`,
      templateContent: `
        <h2 style="margin:0 0 16px 0;font-size:20px;color:#111827;">High registration volume detected</h2>
        <p><strong>${count}</strong> new applications were created in the last 60 minutes, exceeding
           the configured threshold of <strong>${threshold}</strong>.</p>
        <p style="font-size:13px;color:#6b7280;">This may indicate abuse. Review recent registrations
           and, if needed, tighten the guardrails from the CEO dashboard.</p>
      `,
    }).catch((err) => console.error('[guardrail] volume alert email error:', err.message));
  } catch (err) {
    console.error('[guardrail] recordSubmissionAlert error:', err.message);
  }
}

module.exports = {
  DEFAULTS,
  readConfig,
  publicConfig,
  updateConfig,
  verifyRecaptcha,
  issueOtp,
  sendOtp,
  verifyAndConsume,
  recordSubmissionAlert,
};
