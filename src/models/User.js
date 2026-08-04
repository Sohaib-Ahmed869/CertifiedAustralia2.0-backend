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
      select: false, // never returned by default — auth flows opt in with .select('+password')
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
      enum: ['Admin', 'Agent', 'Student', 'InternalRTO', 'ExternalRTO', 'Support', 'CEOReportingManager', 'Marketing'],
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
    // RTO-specific: direct student communication toggle (CA-04)
    directStudentCommunication: {
      type: Boolean,
      default: false,
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
    // Whether this user operates as a sales agent — i.e. is assignable to
    // applications and tracked in Agent Performance / the call scorecard / targets.
    // Decoupled from `role` on purpose: higher roles (Admin/CEOReportingManager)
    // often still sell, and should be trackable as agents without demoting them.
    // Seeded from role on creation (Agent → true) via the pre-save hook below,
    // then managed explicitly from the User Management page.
    isSalesAgent: {
      type: Boolean,
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

// Seed the sales-agent flag from role on creation when it wasn't set explicitly:
// Agent-role users are sales agents by default; everyone else is opt-in. After
// creation the flag is authoritative and only changes via User Management.
userSchema.pre('save', function (next) {
  if (this.isNew && (this.isSalesAgent === undefined || this.isSalesAgent === null)) {
    this.isSalesAgent = this.role === 'Agent';
  }
  next();
});

// Method to compare password
userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

userSchema.index({ role: 1 });
userSchema.index({ isSalesAgent: 1 });

module.exports = mongoose.model('User', userSchema);
