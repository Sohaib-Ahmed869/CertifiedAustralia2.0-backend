const mongoose = require('mongoose');

const applicationSchema = new mongoose.Schema(
  {
    // Unique application identifier (APP10000 format)
    applicationId: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    industryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Industry',
      required: true,
    },
    qualificationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Qualification',
      required: true,
    },
    // Application state from journey
    status: {
      type: String,
      enum: [
        'New',
        'WaitingForPayment',
        'StudentIntakeForm',
        'UploadDocuments',
        'DocumentsUploaded',
        'StudentCompleted',
        'SentToRTO',
        'WaitingForVerification',
        'ReadyForRTOPayment',
        'RTOInvoiceUploaded',
        'CertificateGenerated',
        'CertificateIssued',
        'Archived',
      ],
      default: 'New',
    },
    previousStatus: {
      type: String,
      enum: [
        'New',
        'WaitingForPayment',
        'StudentIntakeForm',
        'UploadDocuments',
        'DocumentsUploaded',
        'StudentCompleted',
        'SentToRTO',
        'WaitingForVerification',
        'ReadyForRTOPayment',
        'RTOInvoiceUploaded',
        'CertificateGenerated',
        'CertificateIssued',
      ],
    },
    assignedAgentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    agentAssignedAt: {
      type: Date,
    },
    assignedRTOId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    rtoAssignmentDate: {
      type: Date,
    },
    // RTO Portal visibility
    sentToRTOPortal: {
      type: Boolean,
      default: false,
    },
    sentToRTOPortalAt: {
      type: Date,
    },
    portalRtoEmail: {
      type: String,
    },
    portalRtoName: {
      type: String,
    },
    // RTO Email Submission
    sentToRTOEmail: {
      type: Boolean,
      default: false,
    },
    sentToRTOEmailAt: {
      type: Date,
    },
    rtoSubmissionEmail: {
      type: String,
    },
    rtoSubmissionName: {
      type: String,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // Single notepad field (rich text HTML)
    note: {
      type: String,
      default: '',
    },
    noteUpdatedAt: {
      type: Date,
    },
    // Discounts (not payments — simple amount + note entries)
    discounts: [
      {
        amount: {
          type: Number,
          required: true,
          min: 0,
        },
        note: {
          type: String,
          default: '',
        },
        createdBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // True once the automatic signup discount has been recorded in `discounts`.
    // Set at registration; guards against a second signup discount being added later.
    signupDiscountApplied: {
      type: Boolean,
      default: false,
    },
    // Financial references
    paymentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Payment',
      },
    ],
    paymentPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentPlan',
    },
    // ── Completion flags (explicit booleans for reliable status derivation) ──
    // Mirrors old project: full_paid = fully paid, partialPayment = at least one payment made
    paymentCompleted: {
      type: Boolean,
      default: false,
    },
    partialPayment: {
      type: Boolean,
      default: false,
    },
    intakeFormSubmitted: {
      type: Boolean,
      default: false,
    },
    documentsUploaded: {
      type: Boolean,
      default: false,
    },
    // Test/demo application — excluded from all admin metrics, dashboards,
    // reporting, and financial aggregations. Still visible/manageable in the
    // students list. Kept in sync onto this application's Payments (Payment.isTest).
    isTest: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Forms
    intakeFormId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'IntakeForm',
    },
    screeningFormId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ScreeningForm',
    },
    // Document tracking
    documentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Document',
      },
    ],
    googleDriveFolderId: {
      type: String,
    },
    // Certificate
    certificateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Certificate',
    },
    // Application lifecycle
    notes: [
      {
        content: String,
        addedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        authorRole: String,
        authorName: String,
        addedAt: {
          type: Date,
          default: Date.now,
        },
        visibility: {
          type: String,
          enum: ['admin', 'rto', 'adminAndRTO', 'rtoToStudent', 'student'],
          default: 'admin',
        },
      },
    ],
    followUpCalls: [
      {
        scheduledFor: Date,
        completedAt: Date,
        outcome: String,
        notes: String,
        loggedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
      },
    ],
    tasks: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Task',
      },
    ],
    // 21-day RTO assessment KPI timer (count-up from start, not countdown)
    // Starts when student completes all obligations. Stops when RTO invoice uploaded.
    timerStartedAt: Date,
    timerStoppedAt: Date,
    timerDaysElapsed: Number,
    // Legacy fields (kept for backward compat with existing data)
    studentCompletionDate: Date,
    rtoCompletionDeadline: Date,
    // Resubmission tracking
    resubmissionRequests: [
      {
        requestedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        requestedAt: Date,
        flaggedDocuments: [String],
        comments: String,
        status: {
          type: String,
          enum: ['pending', 'submitted', 'resolved'],
          default: 'pending',
        },
        resolvedAt: Date,
      },
    ],
    // Gated additional document requests (CA-08)
    additionalDocRequests: [
      {
        requestedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        requestedAt: {
          type: Date,
          default: Date.now,
        },
        items: [
          {
            label: { type: String, required: true },
            description: String,
            required: { type: Boolean, default: true },
          },
        ],
        deadline: Date,
        status: {
          type: String,
          enum: ['open', 'submitted', 'reviewed', 'approved', 'rejected'],
          default: 'open',
        },
        submittedAt: Date,
        reviewedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        reviewedAt: Date,
        reviewNotes: String,
        documentIds: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Document',
          },
        ],
      },
    ],
    // RTO submission version tracking (CA-08 duplicate prevention)
    rtoSubmissions: [
      {
        sentAt: {
          type: Date,
          default: Date.now,
        },
        sentBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        packageVersion: {
          type: Number,
          default: 1,
        },
        documentsIncluded: [String],
        emailSent: {
          type: Boolean,
          default: false,
        },
        superseded: {
          type: Boolean,
          default: false,
        },
        // ── Document access control (see Docs/RTO-DOC-ACCESS-IMPLEMENTATION-PLAN.md) ──
        // Emailed document links are signed against this subdoc's _id. The link is only
        // honoured while the submission is the current one, unrevoked and unexpired —
        // so sending a new submission closes the previous submission's links.
        sentToEmail: String,
        documentIds: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Document',
          },
        ],
        expiresAt: Date,
        revokedAt: Date,
        revokedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        accessLog: [
          {
            documentId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'Document',
            },
            at: {
              type: Date,
              default: Date.now,
            },
            ip: String,
            userAgent: String,
          },
        ],
      },
    ],
    // RTO activity log — tracks all RTO actions for audit (CA-06)
    rtoActivityLog: [
      {
        action: {
          type: String,
          enum: ['viewed', 'downloaded', 'status_updated', 'feedback_sent', 'note_added', 'timer_paused', 'timer_resumed'],
          required: true,
        },
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        detail: String,
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Audit trail
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    leadStatus: {
      type: String,
      enum: ['new', 'contacted', 'qualified', 'converted', 'lost'],
      default: 'new',
    },
    // Color-coding for application management
    color: {
      type: String,
      enum: ['red', 'orange', 'yellow', 'gray', 'green', 'pink', 'lightblue', 'turquoise', ''],
      default: '',
    },
    // Application status (journey stage) change trail — powers the Timeline tab dates.
    // Auto-maintained by schema hooks below on every status transition.
    statusHistory: [
      {
        status: { type: String },
        changedAt: { type: Date, default: Date.now },
      },
    ],
    // Lead status (color) change trail — powers the CEO Lead Status Tracking tab
    leadStatusHistory: [
      {
        color: {
          type: String,
          enum: ['red', 'orange', 'yellow', 'gray', 'green', 'pink', 'lightblue', 'turquoise', ''],
        },
        previousColor: {
          type: String,
          enum: ['red', 'orange', 'yellow', 'gray', 'green', 'pink', 'lightblue', 'turquoise', ''],
        },
        changedAt: { type: Date, default: Date.now },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        changedByName: { type: String },
      },
    ],
    // Reference letter template request tracking
    refLetterRequested: {
      type: Boolean,
      default: false,
    },
    refLetterRequestedAt: Date,
    // Contact tracking
    contactAttempts: {
      type: Number,
      default: 0,
    },
    incomingCalls: {
      type: Number,
      default: 0,
    },
    contactStatus: {
      type: String,
      default: '',
    },
    lastContactedAt: {
      type: Date,
    },
    // Dynamic forms — opt-in per application
    dynamicFormsEnabled: {
      type: Boolean,
      default: false,
    },
    // Marketing source attribution — copied from Student on creation
    sourceAttribution: {
      source: String,
      platform: String,
      campaign: String,
      timestamp: Date,
      // Refer-a-Friend: the referring student/user (captured from ?ref= on signup)
      referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
  }
);

applicationSchema.index({ studentId: 1 });
applicationSchema.index({ status: 1 });
applicationSchema.index({ assignedAgentId: 1 });
applicationSchema.index({ assignedRTOId: 1 });
applicationSchema.index({ studentId: 1, status: 1 });
// Subdocument _ids are not indexed by default — RTO document links resolve by this.
applicationSchema.index({ 'rtoSubmissions._id': 1 });

// ── Status history tracking ──────────────────────────────────────────
// Record every journey-stage transition (used by the Timeline tab to show
// per-stage dates). Covers both write patterns: document .save() and
// findOneAndUpdate (which findByIdAndUpdate delegates to).

// New docs: seed history with the initial status.
applicationSchema.pre('save', function seedStatusHistory(next) {
  if (this.isNew) {
    if (!this.statusHistory || this.statusHistory.length === 0) {
      this.statusHistory = [{ status: this.status, changedAt: this.createdAt || new Date() }];
    }
  } else if (this.isModified('status')) {
    this.statusHistory = this.statusHistory || [];
    this.statusHistory.push({ status: this.status, changedAt: new Date() });
  }
  next();
});

// findOneAndUpdate/findByIdAndUpdate: append when the update changes status.
applicationSchema.pre('findOneAndUpdate', async function trackStatusHistory(next) {
  try {
    const update = this.getUpdate() || {};
    const nextStatus = update.status || (update.$set && update.$set.status);
    if (!nextStatus) return next();

    const current = await this.model.findOne(this.getQuery()).select('status').lean();
    // Only record a real transition (skip no-op updates that re-set the same status).
    if (current && current.status === nextStatus) return next();

    const entry = { status: nextStatus, changedAt: new Date() };
    if (update.$push) update.$push.statusHistory = entry;
    else update.$push = { statusHistory: entry };
    this.setUpdate(update);
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Application', applicationSchema);
