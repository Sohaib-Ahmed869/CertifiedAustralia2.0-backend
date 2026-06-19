const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const User = require('../models/User');
const Student = require('../models/Student');
const Application = require('../models/Application');
const ScreeningForm = require('../models/ScreeningForm');
const AppError = require('../utils/AppError');
const { sendTemplatedEmail } = require('./emailService');

const signToken = (id, mfaVerified = false) =>
  jwt.sign({ id, mfaVerified }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

const signMfaPendingToken = (id) =>
  jwt.sign({ id, mfaPending: true }, process.env.JWT_SECRET, {
    expiresIn: '5m',
  });

const generateApplicationId = async () => {
  const last = await Application.findOne().sort('-applicationId').lean();
  if (!last) return 'APP10000';
  const num = parseInt(last.applicationId.replace('APP', ''), 10);
  return `APP${num + 1}`;
};

const register = async (data) => {
  const {
    firstName, lastName, email, phone, password,
    termsAccepted, source,
    industryId, qualificationId,
    yearsOfExperience, experienceLocation, state,
    hasFormalQualifications, formalQualifications,
  } = data;

  if (!firstName || !lastName || !email || !password) {
    throw new AppError('First name, last name, email, and password are required', 400);
  }
  if (password.length < 8) throw new AppError('Password must be at least 8 characters', 400);
  if (!termsAccepted) throw new AppError('You must accept the terms of service', 400);
  if (!industryId || !qualificationId) throw new AppError('Industry and qualification are required', 400);

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw new AppError('An account with this email already exists', 409);

  // 1. Create student
  const student = await Student.create({
    firstName,
    lastName,
    email: email.toLowerCase(),
    phone,
    password,
    role: 'Student',
    status: 'active',
    portalAccess: ['student'],
    consents: {
      termsOfServiceAccepted: true,
      acceptedAt: new Date(),
    },
    sourceAttribution: source ? { source, timestamp: new Date() } : undefined,
  });

  // 2. Create application
  const applicationId = await generateApplicationId();
  const application = await Application.create({
    applicationId,
    studentId: student._id,
    industryId,
    qualificationId,
    status: 'New',
    leadStatus: 'new',
  });

  // 3. Create screening form
  const screeningForm = await ScreeningForm.create({
    applicationId: application._id,
    industryId,
    qualificationId,
    yearsOfExperience: yearsOfExperience || undefined,
    experienceLocation: experienceLocation || undefined,
    state: state || undefined,
    hasFormalQualifications: hasFormalQualifications || false,
    formalQualifications: formalQualifications ? [formalQualifications] : [],
    status: 'submitted',
    submittedAt: new Date(),
  });

  // 4. Link screening form to application and application to student
  application.screeningFormId = screeningForm._id;
  await application.save();

  student.applicationIds = [application._id];
  await student.save({ validateBeforeSave: false });

  const token = signToken(student._id, true);
  const { password: _, ...userData } = student.toObject();

  return { token, user: userData };
};

const login = async ({ email, password }) => {
  if (!email || !password) throw new AppError('Email and password are required', 400);

  const user = await User.findOne({ email }).select('+password +mfaSecret');
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('Invalid email or password', 401);
  }
  if (user.status !== 'active') throw new AppError('Account is deactivated', 403);

  // MFA is not required for Students — only staff/admin roles
  if (user.mfaEnabled && user.role !== 'Student') {
    const mfaToken = signMfaPendingToken(user._id);
    return {
      mfaRequired: true,
      mfaToken,
      user: { _id: user._id, firstName: user.firstName, email: user.email },
    };
  }

  // No MFA — issue full access token
  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  const token = signToken(user._id, true);
  const { password: _, mfaSecret: __, ...userData } = user.toObject();

  return { mfaRequired: false, token, user: userData };
};

const verifyMfa = async ({ mfaToken, otp }) => {
  if (!mfaToken || !otp) throw new AppError('MFA token and OTP are required', 400);

  let decoded;
  try {
    decoded = jwt.verify(mfaToken, process.env.JWT_SECRET);
  } catch {
    throw new AppError('MFA session expired, please login again', 401);
  }
  if (!decoded.mfaPending) throw new AppError('Invalid MFA token', 401);

  const user = await User.findById(decoded.id).select('+mfaSecret');
  if (!user) throw new AppError('User not found', 404);

  const verified = speakeasy.totp.verify({
    secret: user.mfaSecret,
    encoding: 'base32',
    token: otp,
    window: 1,
  });

  if (!verified) throw new AppError('Invalid OTP code', 401);

  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  const token = signToken(user._id, true);
  const { password: _, mfaSecret: __, ...userData } = user.toObject();

  return { token, user: userData };
};

const setupMfa = async (userId) => {
  const user = await User.findById(userId).select('+mfaSecret');
  if (!user) throw new AppError('User not found', 404);

  const secret = speakeasy.generateSecret({
    name: `CertifiedAustralia (${user.email})`,
    issuer: 'CertifiedAustralia',
  });

  user.mfaSecret = secret.base32;
  await user.save({ validateBeforeSave: false });

  return { otpauthUrl: secret.otpauth_url, base32: secret.base32 };
};

const confirmMfa = async (userId, otp) => {
  const user = await User.findById(userId).select('+mfaSecret');
  if (!user) throw new AppError('User not found', 404);
  if (!user.mfaSecret) throw new AppError('MFA setup not initiated', 400);

  const verified = speakeasy.totp.verify({
    secret: user.mfaSecret,
    encoding: 'base32',
    token: otp,
    window: 1,
  });

  if (!verified) throw new AppError('Invalid OTP code', 400);

  user.mfaEnabled = true;
  await user.save({ validateBeforeSave: false });

  return { message: 'MFA enabled successfully' };
};

const disableMfa = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);

  user.mfaEnabled = false;
  user.mfaSecret = undefined;
  await user.save({ validateBeforeSave: false });

  return { message: 'MFA disabled' };
};

const forgotPassword = async (email) => {
  if (!email) throw new AppError('Email is required', 400);

  const user = await User.findOne({ email });
  if (!user) {
    // Don't reveal whether the email exists
    return { message: 'If that email is registered, a reset link has been sent' };
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  user.passwordResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
  user.passwordResetExpires = Date.now() + 60 * 60 * 1000; // 1 hour
  await user.save({ validateBeforeSave: false });

  // Send branded password-reset email (non-blocking — failures are logged, not thrown)
  const resetUrl = `${process.env.APP_BASE_URL || 'http://localhost:5173'}/reset-password?token=${resetToken}`;

  sendTemplatedEmail({
    to: user.email,
    subject: 'Reset Your Password — Certified Australia',
    preheader: 'You requested a password reset. This link expires in 1 hour.',
    templateContent: `
      <h2 style="margin:0 0 16px 0;font-size:20px;color:#111827;">Password Reset Request</h2>
      <p>Hi ${user.firstName || 'there'},</p>
      <p>We received a request to reset the password for your Certified Australia account.
         Click the button below to choose a new password. This link will expire in
         <strong>1 hour</strong>.</p>
      <p style="margin-top:24px;font-size:13px;color:#6b7280;">
        If you didn't request this, you can safely ignore this email — your password
        will remain unchanged.</p>
    `,
    ctaText: 'Reset Password',
    ctaUrl: resetUrl,
  }).catch((err) => {
    console.error('[AuthService] Password-reset email dispatch error:', err.message);
  });

  // In development, also return the raw token for easy testing
  return {
    message: 'If that email is registered, a reset link has been sent',
    ...(process.env.NODE_ENV === 'development' && { resetToken }),
  };
};

const resetPassword = async ({ token, password }) => {
  if (!token || !password) throw new AppError('Token and new password are required', 400);
  if (password.length < 8) throw new AppError('Password must be at least 8 characters', 400);

  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  }).select('+passwordResetToken +passwordResetExpires');

  if (!user) throw new AppError('Token is invalid or has expired', 400);

  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  const accessToken = signToken(user._id, true);
  const { password: _, ...userData } = user.toObject();

  return { token: accessToken, user: userData };
};

const getMe = async (userId) => {
  const user = await User.findById(userId).select('-password');
  if (!user) throw new AppError('User not found', 404);
  return user;
};

const changePassword = async (userId, currentPassword, newPassword) => {
  if (!currentPassword || !newPassword) {
    throw new AppError('Current password and new password are required', 400);
  }
  if (newPassword.length < 8) {
    throw new AppError('New password must be at least 8 characters', 400);
  }

  const user = await User.findById(userId).select('+password');
  if (!user) throw new AppError('User not found', 404);

  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) throw new AppError('Current password is incorrect', 401);

  user.password = newPassword;
  await user.save();

  return { message: 'Password changed successfully' };
};

module.exports = {
  register,
  login,
  verifyMfa,
  setupMfa,
  confirmMfa,
  disableMfa,
  forgotPassword,
  resetPassword,
  getMe,
  changePassword,
};
