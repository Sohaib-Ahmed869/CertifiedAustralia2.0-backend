const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const guardrailService = require('../services/guardrailService');

/**
 * optionalAuth — decode a Bearer token if present and attach req.user.
 * Never throws; a missing/invalid token simply leaves req.user undefined.
 * Used so authenticated staff (agents registering on behalf) can bypass the
 * public-registration guards.
 */
const optionalAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();
  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (user && user.status === 'active') req.user = user;
  } catch { /* ignore — treat as anonymous */ }
  next();
});

/** True when the request is from authenticated staff (anyone but a Student). */
const isStaff = (req) => !!(req.user && req.user.role && req.user.role !== 'Student');

/**
 * Config-driven per-IP sliding-window rate guard. In-memory (per instance);
 * documented as a horizontal-scaling caveat. Reads window/max from
 * GuardrailConfig each request so the CEO can tune limits without redeploy.
 */
const buckets = new Map(); // key -> number[] (timestamps)

function rateGuard({ windowField, maxField, prefix }) {
  return asyncHandler(async (req, res, next) => {
    if (isStaff(req)) return next(); // authenticated staff are exempt
    const config = await guardrailService.readConfig();
    const max = config[maxField];
    const windowMs = (config[windowField] || 0) * 60 * 1000;
    if (!max || max <= 0 || windowMs <= 0) return next(); // disabled

    const key = `${prefix}:${req.ip}`;
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      throw new AppError('Too many requests. Please slow down and try again later.', 429);
    }
    hits.push(now);
    buckets.set(key, hits);
    next();
  });
}

const createSubmissionRateGuard = rateGuard({ windowField: 'createWindowMin', maxField: 'createMax', prefix: 'create' });
const otpSendRateGuard = rateGuard({ windowField: 'otpSendWindowMin', maxField: 'otpSendMax', prefix: 'otp' });

/**
 * enforceRegistrationGuards — captcha + OTP gate for the public register path.
 * Authenticated staff bypass entirely. Otherwise reads the live config and,
 * per toggle, verifies the reCAPTCHA token and consumes an OTP.
 */
const enforceRegistrationGuards = asyncHandler(async (req, res, next) => {
  if (isStaff(req)) return next();

  const config = await guardrailService.readConfig();

  if (config.captchaEnabled) {
    const ok = await guardrailService.verifyRecaptcha(req.body.captchaToken, req.ip);
    if (!ok) throw new AppError('Captcha verification failed. Please try again.', 400);
  }

  if (config.emailOtpEnabled || config.smsOtpEnabled) {
    const allowedChannels = [
      ...(config.emailOtpEnabled ? ['email'] : []),
      ...(config.smsOtpEnabled ? ['sms'] : []),
    ];
    await guardrailService.verifyAndConsume({
      verificationId: req.body.verificationId,
      otp: req.body.otp,
      purpose: 'registration',
      allowedChannels,
    });
  }

  next();
});

module.exports = {
  optionalAuth,
  createSubmissionRateGuard,
  otpSendRateGuard,
  enforceRegistrationGuards,
};
