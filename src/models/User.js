const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
    },
    firstName: {
      type: String,
      required: true,
    },
    lastName: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
    },
    role: {
      type: String,
      enum: ['Admin', 'Agent', 'Student', 'InternalRTO', 'ExternalRTO', 'Support', 'CEOReportingManager'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'blocked', 'removed'],
      default: 'active',
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    mfaEnabled: {
      type: Boolean,
      default: false,
    },
    mfaSecret: {
      type: String,
      select: false,
    },
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },
    verifiedEmail: {
      type: String,
    },
    verifiedPhone: {
      type: String,
    },
    portalAccess: {
      type: [String],
      enum: ['admin', 'student', 'rto', 'support'],
    },
    // RBAC: per-user permission overrides (Map<String, Boolean>)
    // undefined = use role default, false = explicitly denied, true = explicitly granted
    permissions: {
      type: Map,
      of: Boolean,
    },
    permissionsUpdatedAt: {
      type: Date,
    },
    permissionsUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // For agents: track their assigned applications count
    assignedApplicationsCount: {
      type: Number,
      default: 0,
    },
    lastLoginAt: {
      type: Date,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { discriminatorKey: 'userType' }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', userSchema);
