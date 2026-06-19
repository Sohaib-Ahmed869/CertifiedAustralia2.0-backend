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
    assignedAgentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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
        addedAt: {
          type: Date,
          default: Date.now,
        },
        visibility: {
          type: String,
          enum: ['admin', 'rto', 'adminAndRTO'],
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
    // 21-day RTO completion KPI
    studentCompletionDate: Date,
    rtoCompletionDeadline: Date,
    rtoCompletionDate: Date,
    timerPausedAt: Date,
    timerPauseReason: String,
    timerBreachReported: Boolean,
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
  }
);

module.exports = mongoose.model('Application', applicationSchema);
