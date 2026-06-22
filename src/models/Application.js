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
