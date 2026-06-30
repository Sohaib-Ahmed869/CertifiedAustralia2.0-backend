const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Parser } = require('json2csv');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const createCrudController = require('./crudController');
const service = require('../services/applicationService');
const Application = require('../models/Application');
const driveService = require('../services/googleDriveService');
const callLogService = require('../services/callLogService');
const { sendEmail } = require('../services/emailService');
const appEmails = require('../services/applicationEmailService');

const applications = createCrudController(service.applications);
const intakeForms = createCrudController(service.intakeForms);
const screeningForms = createCrudController(service.screeningForms);
const documents = createCrudController(service.documents);
const certificates = createCrudController(service.certificates);

module.exports = {
  applications,
  intakeForms,
  screeningForms,
  documents,
  certificates,
  createApplication: asyncHandler(async (req, res) => {
    const result = await service.createApplication(req.body);
    res.status(201).json({ item: result });
  }),
  updateApplication: applications.update,
  deleteApplication: applications.remove,
  getApplication: applications.getById,

  /* ── Optimized student detail — single app + sibling snapshots ── */
  getStudentDetail: asyncHandler(async (req, res) => {
    const { studentId, id: applicationId } = req.params;
    const result = await service.getStudentDetail(studentId, applicationId);
    res.status(200).json(result);
  }),
  assignAgent: asyncHandler(async (req, res) => {
    const result = await service.assignAgent(req.params.id, req.body.assignedAgentId);
    res.status(200).json({ item: result });
  }),
  assignRTO: asyncHandler(async (req, res) => {
    const result = await service.assignRTO(req.params.id, req.body.assignedRTOId);
    res.status(200).json({ item: result });
  }),
  sendToRTOPortal: asyncHandler(async (req, res) => {
    const result = await service.sendToRTOPortal(req.params.id, req.body.rtoUserId);
    res.status(200).json({ item: result });
  }),
  sendRTOSubmission: asyncHandler(async (req, res) => {
    const result = await service.sendRTOSubmission(req.params.id, {
      rtoEmail: req.body.rtoEmail,
      rtoName: req.body.rtoName,
    });
    res.status(200).json({ item: result });
  }),
  updateStatus: asyncHandler(async (req, res) => {
    const result = await service.updateStatus(req.params.id, req.body.status);
    res.status(200).json({ item: result });
  }),
  restoreFromArchive: asyncHandler(async (req, res) => {
    const result = await service.restoreFromArchive(req.params.id);
    res.status(200).json({ item: result });
  }),
  createIntakeForm: asyncHandler(async (req, res) => {
    const result = await service.createIntakeForm(req.params.id, req.body);
    res.status(201).json({ item: result });
  }),
  updateIntakeForm: asyncHandler(async (req, res) => {
    const result = await service.intakeForms.update(req.params.formId, req.body);
    res.status(200).json({ item: result });
  }),
  createScreeningForm: asyncHandler(async (req, res) => {
    const result = await service.createScreeningForm(req.params.id, req.body);
    res.status(201).json({ item: result });
  }),
  updateScreeningForm: asyncHandler(async (req, res) => {
    const result = await service.screeningForms.update(req.params.formId, req.body);
    res.status(200).json({ item: result });
  }),
  uploadDocument: asyncHandler(async (req, res) => {
    const result = await service.uploadDocument(req.params.id, req.body);
    res.status(201).json({ item: result });
  }),
  uploadCertificate: asyncHandler(async (req, res) => {
    const appId = req.params.id;

    if (!req.file) throw new AppError('Certificate file is required', 400);

    const application = await Application.findById(appId).populate('studentId');
    if (!application) {
      fs.unlink(req.file.path, () => {});
      throw new AppError('Application not found', 404);
    }

    // Ensure Google Drive folder exists (uses cache + dedup)
    let folderId = application.googleDriveFolderId;
    if (!folderId) {
      const s = application.studentId;
      const studentName = s ? `${s.firstName || ''} ${s.lastName || ''}`.trim() : '';
      const parts = [application.applicationId];
      if (studentName) parts.push(studentName);
      folderId = await driveService.getOrCreateAppFolder(
        application.applicationId,
        parts.join(' - '),
      );
      application.googleDriveFolderId = folderId;
      await application.save();
    }

    // Upload to Google Drive
    const driveName = `Certificate_${crypto.randomUUID()}_${req.file.originalname}`;
    const driveFile = await driveService.uploadFileFromDisk({
      filePath: req.file.path,
      fileName: driveName,
      mimeType: req.file.mimetype,
      folderId,
    });

    // Cleanup temp file
    fs.unlink(req.file.path, () => {});

    const certData = {
      certificateLink: driveFile.webViewLink,
      googleDriveFileId: driveFile.id,
      issuedBy: req.user._id,
    };

    const result = await service.issueCertificate(appId, certData);
    res.status(201).json({ item: result });
  }),
  addNote: asyncHandler(async (req, res) => {
    // Validate rtoToStudent visibility — only allowed if RTO has directStudentCommunication enabled
    if (req.body.visibility === 'rtoToStudent') {
      if (req.user.role !== 'InternalRTO' || !req.user.directStudentCommunication) {
        return res.status(403).json({ message: 'Direct student communication is not enabled for this RTO account' });
      }
    }

    const result = await service.addNote(req.params.id, {
      ...req.body,
      addedBy: req.user._id,
      authorRole: req.user.role,
      authorName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email,
    });

    // Notify student when RTO sends a direct note
    if (req.body.visibility === 'rtoToStudent') {
      try {
        const app = await Application.findById(req.params.id).select('studentId applicationId').lean();
        if (app?.studentId) {
          const { notifyWithEmail } = require('../services/notificationService');
          const authorName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'RTO';
          await notifyWithEmail(app.studentId, {
            type: 'feedback_received',
            title: 'New Message from RTO',
            message: `${authorName} has sent you a message regarding your application ${app.applicationId}.`,
            link: '/student/application',
            relatedId: app._id,
          }, { subject: `New Message from RTO — ${app.applicationId}` });
        }
      } catch (err) {
        console.error('[AddNote] Failed to notify student:', err.message);
      }
    }

    res.status(201).json({ item: result });
  }),

  searchNotes: asyncHandler(async (req, res) => {
    const results = await service.searchNotes(req.query.q, {
      visibility: req.query.visibility,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.status(200).json({ items: results });
  }),

  editNote: asyncHandler(async (req, res) => {
    const result = await service.editNote(req.params.id, req.params.noteId, {
      content: req.body.content,
      userId: req.user._id,
      userRole: req.user.role,
    });
    res.status(200).json({ item: result });
  }),

  deleteNote: asyncHandler(async (req, res) => {
    const result = await service.deleteNote(req.params.id, req.params.noteId, {
      userId: req.user._id,
      userRole: req.user.role,
    });
    res.status(200).json({ item: result });
  }),

  /* ── Follow-up calls ── */
  addFollowUp: asyncHandler(async (req, res) => {
    const result = await service.addFollowUp(req.params.id, {
      scheduledFor: req.body.scheduledFor,
      notes: req.body.notes,
      loggedBy: req.user._id,
    });
    res.status(201).json({ item: result });
  }),
  completeFollowUp: asyncHandler(async (req, res) => {
    const result = await service.completeFollowUp(req.params.id, req.params.followUpId, {
      outcome: req.body.outcome,
      notes: req.body.notes,
    });
    res.status(200).json({ item: result });
  }),
  /* ── Dynamic Forms toggle + available forms ── */
  toggleDynamicForms: asyncHandler(async (req, res) => {
    const app = await Application.findById(req.params.id);
    if (!app) throw new AppError('Application not found', 404);
    app.dynamicFormsEnabled = !app.dynamicFormsEnabled;
    await app.save();

    // When forms are enabled, notify the student by email
    if (app.dynamicFormsEnabled) {
      try {
        const DynamicForm = require('../models/DynamicForm');
        const User = require('../models/User');
        const student = await User.findById(app.studentId).select('firstName email').lean();
        if (student?.email) {
          const forms = app.qualificationId
            ? await DynamicForm.find({ qualificationIds: app.qualificationId, status: 'active' })
                .select('name').lean()
            : [];
          appEmails.sendDynamicFormsEnabledEmail(student, app, forms)
            .catch((e) => console.error('[AppController] Dynamic forms email error:', e.message));
        }
      } catch (e) {
        console.error('[AppController] Failed to send dynamic forms email:', e.message);
      }
    }

    res.status(200).json({ item: { _id: app._id, dynamicFormsEnabled: app.dynamicFormsEnabled } });
  }),

  getAvailableForms: asyncHandler(async (req, res) => {
    const DynamicForm = require('../models/DynamicForm');
    const FormSubmission = require('../models/FormSubmission');

    const app = await Application.findById(req.params.id).lean();
    if (!app) throw new AppError('Application not found', 404);

    if (!app.dynamicFormsEnabled) {
      return res.status(200).json({ forms: [], enabled: false });
    }

    const qualId = app.qualificationId;
    if (!qualId) return res.status(200).json({ forms: [], enabled: true });

    // Get all active forms for this qualification
    const forms = await DynamicForm.find({
      qualificationIds: qualId,
      status: 'active',
    }).sort('displayOrder').lean();

    // Get existing submissions for this application
    const submissions = await FormSubmission.find({
      applicationId: app._id,
    }).select('formId status updatedAt').lean();

    const subMap = new Map();
    submissions.forEach((s) => subMap.set(s.formId?.toString(), s));

    const result = forms.map((f) => {
      const sub = subMap.get(f._id.toString());
      return {
        ...f,
        submission: sub ? { _id: sub._id, status: sub.status, updatedAt: sub.updatedAt } : null,
      };
    });

    res.status(200).json({ forms: result, enabled: true });
  }),

  deleteFollowUp: asyncHandler(async (req, res) => {
    const result = await service.deleteFollowUp(req.params.id, req.params.followUpId);
    res.status(200).json({ item: result });
  }),

  addDiscount: asyncHandler(async (req, res) => {
    const result = await service.addDiscount(req.params.id, {
      ...req.body,
      createdBy: req.user._id,
    });
    res.status(201).json({ item: result });
  }),

  removeDiscount: asyncHandler(async (req, res) => {
    const result = await service.removeDiscount(req.params.id, req.params.discountId);
    res.status(200).json({ item: result });
  }),

  createAdditionalDocRequest: asyncHandler(async (req, res) => {
    const result = await service.createAdditionalDocRequest(req.params.id, {
      ...req.body,
      requestedBy: req.user._id,
    });
    res.status(201).json({ item: result });
  }),

  submitAdditionalDocs: asyncHandler(async (req, res) => {
    const result = await service.submitAdditionalDocs(req.params.id, req.params.requestId);
    res.status(200).json({ item: result });
  }),

  reviewAdditionalDocs: asyncHandler(async (req, res) => {
    const result = await service.reviewAdditionalDocs(req.params.id, req.params.requestId, {
      ...req.body,
      reviewedBy: req.user._id,
    });
    res.status(200).json({ item: result });
  }),

  logRTOActivity: asyncHandler(async (req, res) => {
    const result = await service.logRTOActivity(req.params.id, {
      ...req.body,
      userId: req.user._id,
    });
    res.status(201).json(result);
  }),

  notifySoftCopy: asyncHandler(async (req, res) => {
    const result = await service.notifySoftCopy(req.params.certId);
    res.status(200).json({ item: result });
  }),

  dispatchHardCopy: asyncHandler(async (req, res) => {
    const result = await service.dispatchHardCopy(req.params.certId, req.body);
    res.status(200).json({ item: result });
  }),

  markCertificateDelivered: asyncHandler(async (req, res) => {
    const confirmedBy = req.user.role === 'Student' ? 'student' : 'staff';
    const result = await service.markCertificateDelivered(req.params.certId, { confirmedBy });
    res.status(200).json({ item: result });
  }),

  createRTOSubmission: asyncHandler(async (req, res) => {
    const result = await service.createRTOSubmission(req.params.id, {
      ...req.body,
      sentBy: req.user._id,
    });
    res.status(201).json({ item: result });
  }),

  logCall: asyncHandler(async (req, res) => {
    const result = await callLogService.logCall(req.params.id, {
      ...req.body,
      agentId: req.user._id,
    });
    res.status(201).json({ item: result });
  }),

  reviewDocument: asyncHandler(async (req, res) => {
    const result = await service.reviewDocument(req.params.id, req.params.docId, {
      ...req.body,
      verifiedBy: req.user._id,
    });
    res.status(200).json({ item: result });
  }),

  getTimerStatus: asyncHandler(async (req, res) => {
    const result = await service.getTimerStatus(req.params.id);
    res.status(200).json(result);
  }),

  getStats: asyncHandler(async (req, res) => {
    const stats = await service.getStats(req.query);
    res.status(200).json({ stats });
  }),

  exportCsv: asyncHandler(async (req, res) => {
    const filters = {
      status: req.query.status,
      agentId: req.query.agentId,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    };

    const data = await service.exportCsv(filters);

    const fields = [
      'applicationId',
      'studentName',
      'studentEmail',
      'qualification',
      'industry',
      'status',
      'assignedAgent',
      'createdAt',
      'price',
      'discount',
      'paymentStatus',
    ];
    const parser = new Parser({ fields });
    const csv = parser.parse(data);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=applications.csv');
    res.status(200).send(csv);
  }),

  /* ── Send Post-Certification Form email ── */
  sendPostCertForm: asyncHandler(async (req, res) => {
    const app = await Application.findById(req.params.id)
      .populate('studentId', 'firstName lastName email')
      .lean();
    if (!app) throw new AppError('Application not found', 404);

    const student = app.studentId;
    if (!student || !student.email) throw new AppError('Student has no email address', 400);

    const firstName = student.firstName || 'there';
    const baseUrl = process.env.APP_BASE_URL || 'https://portal.certifiedaustralia.com.au';
    const formLink = `${baseUrl}/post-certification-form?userId=${student._id}`;

    const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background-color: #ececec; color: #333; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
        .outer { max-width: 680px; margin: 0 auto; padding: 32px 20px; width: 100%; box-sizing: border-box; text-align: left; }
        .card { background: #ffffff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); overflow: hidden; margin-bottom: 16px; text-align: left; }
        .logo-bar { text-align: center; padding: 32px 40px 24px; border-bottom: 1px solid #eee; }
        .logo-bar img { max-width: 200px; height: auto; }
        .card-title { padding: 24px 40px 0; }
        .card-title h2 { color: #089C34; font-size: 22px; margin: 0; font-weight: 700; letter-spacing: 0.3px; }
        .card-body { padding: 24px 40px 36px; line-height: 1.85; font-size: 15px; color: #333; text-align: left; }
        .card-body p { margin: 0 0 16px; text-align: left; }
        .bold { font-weight: 700; }
        .bold-green { font-weight: 700; color: #089C34; }
        .divider { border: none; border-top: 1px solid #eee; margin: 28px 0; }
        .step { margin: 16px 0; padding: 14px 18px; background: #f8faf9; border-left: 3px solid #089C34; border-radius: 0 10px 10px 0; text-align: left; }
        .step .step-title { font-weight: 700; color: #1a1a2e; margin-bottom: 4px; font-size: 15px; }
        .step p { margin: 0; color: #555; font-size: 14px; }
        .highlight { background: #f0faf4; border-left: 4px solid #089C34; border-radius: 10px; padding: 18px 22px; margin: 28px 0; font-weight: 600; color: #1a5c35; font-size: 16px; line-height: 1.7; text-align: left; }
        .price-card { background: #1a1a2e; color: #fff; border-radius: 14px; padding: 28px 32px; margin: 28px 0; font-size: 15px; line-height: 2; box-shadow: 0 4px 16px rgba(26,26,46,0.2); text-align: left; }
        .price-card .total { font-size: 20px; font-weight: 700; color: #2ecc71; margin-top: 12px; }
        .cta-section { text-align: center; margin: 36px 0 10px; }
        .btn { display: inline-block; background: #089C34; color: #fff !important; padding: 16px 48px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 16px; letter-spacing: 0.5px; }
        .attachment-note { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px 20px; margin: 24px 0 0; font-size: 13px; color: #666; text-align: center; }
        .attachment-note strong { color: #333; }
        .footer-card { background: #1a1a2e; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); padding: 24px 40px; text-align: center; font-size: 12px; color: rgba(255,255,255,0.6); }
        .footer-card a { color: #2ecc71; text-decoration: none; }

        @media only screen and (max-width: 480px) {
          .outer-td { padding: 16px 8px !important; }
          .outer { padding: 16px 10px !important; }
          .card-body { padding: 24px 20px !important; font-size: 14px !important; }
          .card-body p { font-size: 14px !important; }
          .step { padding: 12px 14px !important; margin: 12px 0 !important; }
          .step .step-title { font-size: 14px !important; }
          .step p { font-size: 13px !important; }
          .highlight { padding: 14px 16px !important; font-size: 14px !important; margin: 20px 0 !important; }
          .price-card { padding: 20px 18px !important; margin: 20px 0 !important; font-size: 14px !important; }
          .price-card .total { font-size: 17px !important; }
          .btn { padding: 14px 32px !important; font-size: 15px !important; width: 100% !important; box-sizing: border-box !important; text-align: center !important; }
          .cta-section { margin: 28px 0 10px !important; }
          .attachment-note { padding: 12px 14px !important; font-size: 12px !important; }
          .footer-card { padding: 20px 18px !important; border-radius: 12px !important; }
          .footer-card p { font-size: 11px !important; }
          .logo-bar { padding: 24px 20px 18px !important; }
          .logo-bar img { max-width: 160px !important; }
          .card-title { padding: 20px 20px 0 !important; }
          .card-title h2 { font-size: 18px !important; }
          .card { border-radius: 12px !important; }
          .divider { margin: 20px 0 !important; }
        }
      </style>
    </head>
    <body style="margin:0; padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ececec; min-width:100%;">
        <tr>
          <td align="center" style="padding: 32px 12px;" class="outer-td">

      <div class="outer">

        <div class="card">
          <div class="logo-bar">
            <img src="https://logosca.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(18).png" alt="Certified Australia" style="max-width: 200px; height: auto;" />
          </div>
          <div class="card-title">
            <h2>Your certification is just the beginning</h2>
          </div>

          <div class="card-body">
            <p>Dear ${firstName},</p>

            <p>We recognised your skills.<br/>
            You put in the work.<br/>
            You earned your certification.</p>

            <p>Getting here wasn't an accident.</p>

            <p>It took years of experience, a commitment to your craft, and the decision to finally have your skills properly recognised.</p>

            <p class="bold">That is NOT something we take lightly.</p>

            <hr class="divider"/>

            <p>But certification is rarely the finish line. For most of our students, it's the moment everything opens up.</p>

            <p class="bold-green">Independence. Legitimacy. Control over your future.</p>

            <p class="bold">The ability to operate on your own terms.</p>

            <p>And here's the important part — After doing the hard work to get qualified, we REFUSE to leave you hanging.</p>

            <p>On the other side of this email is something many people spend years thinking about but never properly set up:</p>

            <div class="highlight">
              Your OWN legitimate business, built the right way, from day one.
            </div>

            <p>From working with thousands of students, we've seen the same path lead to success time and time again:</p>

            <div class="step">
              <p class="step-title">Step 1: Register your business properly</p>
              <p>The right structure, the right registrations, and compliance done correctly from the start.</p>
            </div>

            <div class="step">
              <p class="step-title">Step 2: Build a professional identity</p>
              <p>Your name, your logo, and how you present yourself — so clients trust you before they ever meet you.</p>
            </div>

            <div class="step">
              <p class="step-title">Step 3: Establish your online presence</p>
              <p>A professional website that represents your trade or service clearly and positions you as credible in your industry.</p>
            </div>

            <div class="step">
              <p class="step-title">Step 4: Marketing that actually works</p>
              <p>Clear, compliant visibility so the right clients can find you when they need your services.</p>
            </div>

            <hr class="divider"/>

            <p>To support this journey, we've built an in-house ecosystem specifically for <strong>YOU</strong>:</p>

            <p class="bold">Certified Accounting &bull; Certified Marketing &bull; Certified Web</p>

            <p>To make this practical and accessible, we've bundled everything into a single offering.</p>

            <div class="price-card">
              <p class="bold" style="font-size:18px; margin-bottom:12px;">Certified Business Starter Pack</p>
              <div>Business registration: <strong>$1,999</strong></div>
              <div>Branding and identity: <strong>$3,999</strong></div>
              <div>Website development: <strong>$5,999</strong></div>
              <div style="color:#aaa; margin-top:6px;">Total value: $11,997</div>
              <div class="total">Because you're a Certified Australia student — $2,000 OFF<br/>Your price: $9,997</div>
            </div>

            <p>This isn't about selling you a service. It's about recognising that you've already done the hard part.</p>

            <p class="bold">You earned your certification.</p>

            <p>Now we want to help you build your business.</p>

            <p>Simply reply to this email or access the next steps section inside your portal. We already understand your background, so this conversation starts where your certification ended.</p>

            <div class="cta-section">
              <a href="${formLink}" class="btn">GET STARTED</a>
            </div>

            <div class="attachment-note">
              <strong>📎 Attached:</strong> Our Marketing &amp; Business Development flyer with full details on our services and packages.
            </div>

            <p style="margin-top: 28px;">Warm regards,<br/><strong>The Certified Australia Team</strong></p>
          </div>
        </div>

        <div class="footer-card">
          <p>&copy; ${new Date().getFullYear()} Certified Australia. All rights reserved.</p>
          <p>1300 044 927 &bull; <a href="mailto:info@certifiedaustralia.com.au">info@certifiedaustralia.com.au</a> &bull; <a href="https://www.certifiedaustralia.com.au">www.certifiedaustralia.com.au</a></p>
        </div>

      </div>

          </td>
        </tr>
      </table>
    </body>
    </html>
    `;

    const pdfPath = path.join(__dirname, '../../docs/Certified Marketing and Business Development Flyer.pdf');
    const attachments = [];
    if (fs.existsSync(pdfPath)) {
      attachments.push({
        filename: 'Certified_Marketing_and_Business_Development_Flyer.pdf',
        path: pdfPath,
        contentDisposition: 'attachment',
      });
    }

    const result = await sendEmail({
      to: student.email,
      subject: `${firstName}, your certification is just the beginning`,
      html: emailHtml,
      attachments,
    });

    if (!result.success) throw new AppError('Failed to send email', 500);

    res.status(200).json({ message: 'Post-certification form sent successfully' });
  }),

  /* ── Send Reference Letter Template email ── */
  sendRefLetterTemplate: asyncHandler(async (req, res) => {
    const ReferenceLetterTemplate = require('../models/ReferenceLetterTemplate');

    const app = await Application.findById(req.params.id)
      .populate('studentId', 'firstName lastName email')
      .populate('qualificationId', 'name code')
      .lean();
    if (!app) throw new AppError('Application not found', 404);

    const student = app.studentId;
    if (!student || !student.email) throw new AppError('Student has no email address', 400);
    if (!app.qualificationId) throw new AppError('Application has no qualification assigned', 400);

    const qualId = typeof app.qualificationId === 'object' ? app.qualificationId._id : app.qualificationId;
    const template = await ReferenceLetterTemplate.findOne({ qualificationId: qualId }).lean();
    if (!template) throw new AppError('No reference letter template for this qualification', 404);

    // Download template file from Google Drive
    const { buffer, fileName: driveFileName, mimeType } = await driveService.downloadFileBuffer(template.googleDriveFileId);

    const firstName = student.firstName || 'Student';
    const lastName = student.lastName || '';
    const qualName = typeof app.qualificationId === 'object'
      ? (app.qualificationId.name || '')
      : '';
    const baseUrl = process.env.APP_BASE_URL || 'https://portal.certifiedaustralia.com.au';

    const { buildEmailHtml } = require('../services/emailService');
    const content = `
      <h2 style="font-size:20px;color:#1f2937;margin:0 0 16px;">Dear ${firstName} ${lastName},</h2>

      <p>
        As part of your RPL (Recognition of Prior Learning) application for
        <strong>${qualName}</strong>, you are required to
        obtain a <strong>Reference Letter</strong> from a current or past employer,
        supervisor, or professional referee who can confirm your skills and experience.
      </p>

      <div style="background-color:#f0faf4; border-left:4px solid #0a9d42; border-radius:8px; padding:16px 20px; margin:20px 0;">
        <h3 style="margin:0 0 8px; font-size:15px; color:#1a5c35;">What is a Reference Letter?</h3>
        <p style="margin:0; color:#333; font-size:14px; line-height:1.6;">
          A reference letter is a written statement from someone who has directly supervised
          or worked alongside you. It confirms your practical skills, industry experience,
          and competencies relevant to the qualification you are applying for.
        </p>
      </div>

      <h3 style="font-size:16px;color:#1f2937;margin:20px 0 12px;">Instructions:</h3>
      <ol style="padding-left:20px; line-height:2; color:#333;">
        <li>Open the attached template document.</li>
        <li>Provide it to your referee (supervisor, employer, or manager).</li>
        <li>Ask them to complete, sign, and date the letter on company letterhead if possible.</li>
        <li>Upload the completed letter to your application portal under <strong>Documents</strong>.</li>
      </ol>

      <div style="background-color:#f0faf4; border:1px solid #d1e7dd; border-radius:8px; padding:16px 20px; margin:20px 0;">
        <p style="margin:0; font-size:14px; color:#2e7d32;">
          📎 <strong>Attached:</strong> ${template.fileName || driveFileName}
        </p>
      </div>

      <p>
        If you have any questions about this process or need assistance, please do not
        hesitate to contact our team.
      </p>

      <p style="margin-top:24px;">Warm regards,<br/><strong>The Certified Australia Team</strong></p>
    `;

    const html = buildEmailHtml(content, {
      ctaText: 'Go to My Application',
      ctaUrl: `${baseUrl}/student`,
      preheader: `Reference Letter Template for ${qualName}`,
    });

    const result = await sendEmail({
      to: student.email,
      subject: `Reference Letter Template — ${qualName}`,
      html,
      attachments: [{
        filename: template.fileName || driveFileName,
        content: buffer,
        contentType: mimeType,
      }],
    });

    if (!result.success) throw new AppError('Failed to send email', 500);

    // Clear the ref letter request badge
    await Application.findByIdAndUpdate(req.params.id, {
      refLetterRequested: false,
    });

    res.status(200).json({ message: 'Reference letter template sent to student' });
  }),

  /* ── Student requests Reference Letter Template ── */
  requestRefLetterTemplate: asyncHandler(async (req, res) => {
    const ReferenceLetterTemplate = require('../models/ReferenceLetterTemplate');
    const { createNotification, notifyMany } = require('../services/notificationService');

    const app = await Application.findById(req.params.id)
      .populate('studentId', 'firstName lastName email')
      .populate('qualificationId', 'name code')
      .lean();
    if (!app) throw new AppError('Application not found', 404);

    const student = app.studentId;
    if (!student) throw new AppError('Student not found', 400);

    const qualName = typeof app.qualificationId === 'object' ? (app.qualificationId.name || '') : '';
    const studentName = `${student.firstName || ''} ${student.lastName || ''}`.trim();

    // Mark the request on the application
    await Application.findByIdAndUpdate(req.params.id, {
      refLetterRequested: true,
      refLetterRequestedAt: new Date(),
    });

    // Try to auto-send template if one exists for this qualification
    const qualId = typeof app.qualificationId === 'object' ? app.qualificationId._id : app.qualificationId;
    const template = qualId ? await ReferenceLetterTemplate.findOne({ qualificationId: qualId }).lean() : null;

    if (template && student.email) {
      // Auto-send the template directly to the student
      try {
        const { buffer, fileName: driveFileName, mimeType } = await driveService.downloadFileBuffer(template.googleDriveFileId);
        const { buildEmailHtml } = require('../services/emailService');
        const html = buildEmailHtml(`
          <h2 style="font-size:20px;color:#1f2937;margin:0 0 16px;">Hi ${student.firstName || 'there'},</h2>
          <p>You requested a reference letter template for <strong>${qualName}</strong>. Please find the template attached.</p>
          <ol style="padding-left:20px; line-height:2; color:#333;">
            <li>Open the attached template document.</li>
            <li>Provide it to your referee (supervisor, employer, or manager).</li>
            <li>Ask them to complete, sign, and date the letter.</li>
            <li>Upload the completed letter to your portal under <strong>Documents</strong>.</li>
          </ol>
          <p>If you need help, contact us at <strong>info@certifiedaustralia.com.au</strong> or call <strong>1300 044 927</strong>.</p>
          <p style="margin-top:16px;">Warm regards,<br/><strong>The Certified Australia Team</strong></p>
        `, { ctaText: 'Upload Documents', ctaUrl: `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/documents`, preheader: `Reference Letter Template for ${qualName}` });

        await sendEmail({
          to: student.email,
          subject: `Reference Letter Template — ${qualName}`,
          html,
          attachments: [{ filename: template.fileName || driveFileName, content: buffer, contentType: mimeType }],
        });
      } catch (err) {
        console.error('[RefLetterTemplate] Auto-send failed:', err.message);
      }
    }

    // Notify admin team regardless (so they know the student requested it)
    try {
      const User = require('../models/User');
      const adminUsers = await User.find({ role: { $in: ['Admin', 'CEOReportingManager'] }, isActive: { $ne: false } }).select('_id').lean();
      const adminIds = adminUsers.map((u) => u._id);
      const studentIdStr = typeof app.studentId === 'object' ? app.studentId._id : app.studentId;
      const notifData = {
        type: 'general',
        title: 'Reference Letter Template Requested',
        message: `${studentName} has requested a reference letter template for ${qualName} (${app.applicationId}).${template ? ' Template was auto-sent.' : ' No template found — please send manually.'}`,
        link: `/admin/students/${studentIdStr}`,
        relatedId: app._id,
      };
      // Also notify the assigned agent if any
      if (app.assignedAgentId) {
        const agentId = typeof app.assignedAgentId === 'object' ? app.assignedAgentId._id : app.assignedAgentId;
        if (!adminIds.some((id) => String(id) === String(agentId))) adminIds.push(agentId);
      }
      await notifyMany(adminIds, notifData);
    } catch (err) {
      console.error('[RefLetterTemplate] Admin notification failed:', err.message);
    }

    res.status(200).json({
      message: template ? 'Template sent to your email and admin has been notified.' : 'Admin team has been notified and will send the template to your email.',
      autoSent: !!template,
    });
  }),

  /* ── Resend Context-Based Email ── */
  resendEmail: asyncHandler(async (req, res) => {
    const IntakeForm = require('../models/IntakeForm');
    const Document = require('../models/Document');
    const Payment = require('../models/Payment');
    const { buildEmail, heading2, greeting: greet, paragraph: para, statusItem, buttonGroup, infoCard, signOff } = require('../services/emailService');

    const app = await Application.findById(req.params.id)
      .populate('studentId', 'firstName lastName email')
      .populate('qualificationId', 'name code')
      .lean();
    if (!app) throw new AppError('Application not found', 404);

    const student = app.studentId;
    if (!student || !student.email) throw new AppError('Student has no email address', 400);

    const studentName = `${student.firstName || ''} ${student.lastName || ''}`.trim() || 'Student';
    const baseUrl = process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'https://portal.certifiedaustralia.com.au';

    const intake = await IntakeForm.findOne({ applicationId: app._id }).lean();
    const docs = await Document.find({ applicationId: app._id }).lean();
    const payments = await Payment.find({ applicationId: app._id, type: { $in: ['upfront', 'plan'] } }).lean();

    const sifComplete = intake && intake.status === 'submitted';
    const hasDocuments = docs.length > 0;
    const totalPaid = payments.filter(p => p.status === 'completed').reduce((s, p) => s + (p.amount || 0), 0);
    const hasPaid = totalPaid > 0;

    let actionText = '';
    if (!sifComplete) actionText = 'To continue with your certification process, please complete your Student Intake Form by clicking the button below:';
    else if (!hasDocuments) actionText = 'To continue with your certification process, please upload your required documents by clicking the button below:';
    else if (!hasPaid) actionText = 'To continue with your certification process, please complete your payment by clicking the button below:';
    else actionText = 'Your application is progressing well. You can view your application status by clicking the button below:';

    const statusRows =
      statusItem('Student Intake Form', sifComplete ? 'Completed' : 'Incomplete', sifComplete) +
      statusItem('Required Documents', hasDocuments ? `${docs.length} Uploaded` : 'Pending', hasDocuments) +
      statusItem('Payment', hasPaid ? `$${totalPaid.toLocaleString()} Paid` : 'Pending', hasPaid);

    const body =
      heading2('Complete Your Application') +
      greet(studentName) +
      para('Thank you for starting your application with Certified Australia.') +
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:16px 0;">${statusRows}</table>` +
      para(actionText) +
      buttonGroup(
        { text: 'Complete Your Application', url: `${baseUrl}/student/application` },
        { text: 'Go to Dashboard', url: `${baseUrl}/student` }
      ) +
      infoCard('Application Process Overview', [
        'Complete the Student Intake Form with your personal and educational details',
        'Upload required documentation to support your application',
        'Complete the payment process',
        'Application review and approval',
      ]) +
      para('If you need assistance with any part of the application process, please don\'t hesitate to contact our support team.') +
      signOff();

    const html = buildEmail(body, 'Complete Your Application with Certified Australia');

    const result = await sendEmail({ to: student.email, subject: 'Complete Your Application with Certified Australia', html });
    if (!result.success) throw new AppError('Failed to send email', 500);
    res.status(200).json({ message: 'Application status email sent to student' });
  }),

  /* ── Send Predefined Email Template ── */
  sendPredefinedEmail: asyncHandler(async (req, res) => {
    const { templateType } = req.body;
    if (!templateType) throw new AppError('templateType is required', 400);

    const app = await Application.findById(req.params.id)
      .populate('studentId', 'firstName lastName email')
      .populate('qualificationId', 'name code')
      .lean();
    if (!app) throw new AppError('Application not found', 404);

    const student = app.studentId;
    if (!student || !student.email) throw new AppError('Student has no email address', 400);

    const studentName = `${student.firstName || ''} ${student.lastName || ''}`.trim() || 'Student';
    const qualName = typeof app.qualificationId === 'object' ? (app.qualificationId.name || '') : '';

    // Price calculation
    const isElectrical = templateType === 'electrical' || templateType.startsWith('electrical_');
    const isAircon = templateType.startsWith('aircon_');
    const basePrice = isElectrical ? 18998 : (app.price || 0);
    const disc = app.discount || 0;
    const netPrice = isAircon ? '$10,000 – $15,000' : (basePrice ? `$${Math.max(0, basePrice - disc).toLocaleString()}` : 'Contact us for pricing');

    const baseUrl = process.env.APP_BASE_URL || 'https://portal.certifiedaustralia.com.au';

    // Shared doc lists
    const rplDocs = `<ul style="padding-left:24px;margin:0;"><li style="margin-bottom:8px;">100 Points of ID</li><li style="margin-bottom:8px;">USI Number</li><li style="margin-bottom:8px;">Photo and video evidence of you working</li><li style="margin-bottom:8px;">Reference Letter</li><li style="margin-bottom:8px;">Resume</li><li style="margin-bottom:8px;">Payslips or invoices as proof of experience</li><li style="margin-bottom:8px;">Any other supporting evidence</li></ul>`;
    const communityDocs = `<ul style="padding-left:24px;margin:0;"><li style="margin-bottom:8px;">100 Points of ID</li><li style="margin-bottom:8px;">USI Number</li><li style="margin-bottom:8px;">Reference Letter</li><li style="margin-bottom:8px;">Resume</li><li style="margin-bottom:8px;">Payslips or invoices as proof of experience</li><li style="margin-bottom:8px;">Any other supporting evidence</li></ul>`;
    const electricalDocs = `<ul style="padding-left:24px;margin:0;"><li style="margin-bottom:8px;">100 Points of Identification</li><li style="margin-bottom:8px;">Updated Resume</li><li style="margin-bottom:8px;">Reference Letter (signed by a licensed electrician)</li><li style="margin-bottom:8px;">USI Transcript</li><li style="margin-bottom:8px;">Payslips and/or Invoices demonstrating work experience</li><li style="margin-bottom:8px;">Photo and video evidence of practical work</li><li style="margin-bottom:8px;">Any additional supporting documents</li></ul>`;
    const airconDocs = `<ul style="padding-left:24px;margin:0;"><li style="margin-bottom:8px;">100 Points of Identification</li><li style="margin-bottom:8px;">Updated Resume</li><li style="margin-bottom:8px;">Reference Letter (signed by someone licensed in air conditioning &amp; refrigeration)</li><li style="margin-bottom:8px;">USI Transcript</li><li style="margin-bottom:8px;">Payslips and/or Invoices demonstrating work experience</li><li style="margin-bottom:8px;">Photo and video evidence of practical work</li><li style="margin-bottom:8px;">Any additional supporting documents</li></ul>`;

    const section = (title, body) => `<div style="margin:24px 0;"><h3 style="color:#0a9d42;font-size:16px;font-weight:600;margin:0 0 12px;">${title}</h3>${body}</div>`;
    const priceFmt = `<p style="font-size:28px;font-weight:700;color:#0a9d42;margin:0;">${netPrice}</p>`;

    const TEMPLATES = {
      general_rpl: {
        subject: `RPL Enquiry - ${qualName}`,
        content: `<p>Hi ${studentName},</p><p>Thank you for your enquiry regarding the <strong>${qualName}</strong>.</p><p>We offer this qualification through Recognition of Prior Learning (RPL), which allows your existing skills and experience to be formally recognised without attending formal training. This qualification is nationally recognised, meaning it is valid across Australia.</p>${section('Documentation Required for RPL', rplDocs)}${section('Details', `<ul style="padding-left:24px;margin:0;"><li style="margin-bottom:8px;"><strong>Processing time:</strong> Approximately 4-6 weeks</li><li style="margin-bottom:8px;"><strong>Cost:</strong> ${netPrice}</li></ul>`)}<p>Please don't hesitate to contact us if you have any questions.</p>`,
      },
      community_hospitality: {
        subject: `RPL Enquiry - ${qualName}`,
        content: `<p>Hi ${studentName},</p><p>Thank you for your enquiry regarding the <strong>${qualName}</strong>.</p><p>We offer this qualification through Recognition of Prior Learning (RPL), which allows your existing skills and experience to be formally recognised without attending formal training. This qualification is nationally recognised, meaning it is valid across Australia.</p>${section('Documentation Required for RPL', communityDocs)}${section('Details', `<ul style="padding-left:24px;margin:0;"><li style="margin-bottom:8px;"><strong>Processing time:</strong> Approximately 4-6 weeks</li><li style="margin-bottom:8px;"><strong>Cost:</strong> ${netPrice}</li></ul>`)}<p>Please don't hesitate to contact us if you have any questions.</p>`,
      },
      electrical: {
        subject: `Electrical RPL Enquiry - ${qualName}`,
        content: `<p>Hi ${studentName},</p><p>Thank you for your inquiry - hope you are well!</p><p>We offer the Certificate III in Electrotechnology Electrician through the RPL (Recognition of Prior Learning) pathway; however, given the high-risk nature of this qualification, there is also a course component involved.</p><p>Based on your extensive experience in the electrical industry, you are eligible to apply for this pathway.</p><div style="background:#FFF9E6;padding:16px 20px;border-left:4px solid #FFB800;margin:20px 0;border-radius:4px;"><p style="margin:0;"><strong>Course Duration:</strong> The course will run for either 6 or 12 months, depending on your level of experience and final course requirements.</p></div><p>At the end of the process, you'll complete a Capstone Assessment. Once successfully completed, you'll be issued with the Certificate III in Electrotechnology Electrician.</p>${section('Documentation Required', electricalDocs)}${section('Cost', priceFmt)}<p>Please let us know if you'd like to enrol and we can begin the process.</p>`,
      },
      electrical_6month: {
        subject: 'Electrical Enquiry - Certificate III in Electrotechnology Electrician (6 Month Course)',
        content: `<p>Hi ${studentName},</p><p>Thank you for your interest in enrolling in the Certificate III in Electrotechnology Electrician 6 Month Course.</p>${section('Experience Requirement', '<ul style="padding-left:24px;margin:0;"><li>Minimum 4 years on-site electrical experience</li></ul>')}${section('Documents Required', electricalDocs)}${section('Course Schedule', '<p>Classes will run 2 days per week from 5:30 PM – 9:30 PM.</p>')}${section('Course Fee', priceFmt)}<p>Once we receive and review the above documents, we will be able to confirm your eligibility and proceed with the enrolment process.</p>`,
      },
      electrical_12month: {
        subject: 'Electrical Enquiry - Certificate III in Electrotechnology Electrician (12 Month Course)',
        content: `<p>Hi ${studentName},</p><p>Thank you for your interest in enrolling in the Certificate III in Electrotechnology Electrician 12 Month Course.</p>${section('Experience Requirement', '<ul style="padding-left:24px;margin:0;"><li>Minimum 1 year working experience in the electrical industry</li></ul>')}${section('Documents Required', electricalDocs)}${section('Course Schedule', '<p>Classes will run 2 days per week from 5:30 PM – 9:30 PM.</p>')}${section('Course Fee', priceFmt)}<p>Once we receive and review the above documents, we will be able to confirm your eligibility and proceed with the enrolment process.</p>`,
      },
      electrical_18month: {
        subject: 'Electrical Enquiry - Certificate III in Electrotechnology Electrician (18 Month Course)',
        content: `<p>Hi ${studentName},</p><p>Thank you for your interest in enrolling in the Certificate III in Electrotechnology Electrician 18 Month Course.</p>${section('Experience Requirement', '<ul style="padding-left:24px;margin:0;"><li>Designed for beginners</li><li>Must be actively working in the electrical field while completing the course</li></ul>')}${section('Documents Required', electricalDocs)}${section('Course Schedule', '<p>Classes will run 2 days per week from 5:30 PM – 9:30 PM.</p>')}${section('Course Fee', priceFmt)}<p>Once we receive and review the above documents, we will be able to confirm your eligibility and proceed with the enrolment process.</p>`,
      },
      aircon_6to8week: {
        subject: 'Air Conditioning & Refrigeration Enquiry - Certificate III (6–8 Week RPL + GAP Course)',
        content: `<p>Hi ${studentName},</p><p>Thank you for your interest in enrolling in the Certificate III in Air Conditioning &amp; Refrigeration 6–8 Week RPL + GAP Course.</p>${section('Experience Requirement', '<ul style="padding-left:24px;margin:0;"><li>Minimum 4 years on-site experience in air conditioning or refrigeration</li><li>ARCtick licence required</li></ul>')}${section('Documents Required', airconDocs)}${section('Course Schedule', '<p>Classes will run 2 days per week from 5:30 PM – 9:30 PM.</p>')}${section('Course Fee', priceFmt)}<p>Once we receive and review the above documents, we will be able to confirm your eligibility and proceed with the enrolment process.</p>`,
      },
      aircon_6to9month: {
        subject: 'Air Conditioning & Refrigeration Enquiry - Certificate III (6–9 Month Course)',
        content: `<p>Hi ${studentName},</p><p>Thank you for your interest in enrolling in the Certificate III in Air Conditioning &amp; Refrigeration 6–9 Month Course.</p>${section('Experience Requirement', '<ul style="padding-left:24px;margin:0;"><li>Minimum 1 year on-site experience in air conditioning or refrigeration</li><li>ARCtick licence required</li></ul>')}${section('Documents Required', airconDocs)}${section('Course Schedule', '<p>Classes will run 2 days per week from 5:30 PM – 9:30 PM.</p>')}${section('Course Fee', priceFmt)}<p>Once we receive and review the above documents, we will be able to confirm your eligibility and proceed with the enrolment process.</p>`,
      },
      aircon_2day: {
        subject: 'Air Conditioning & Refrigeration Enquiry - Certificate III (2 Day Assessment)',
        content: `<p>Hi ${studentName},</p><p>Thank you for your interest in enrolling in the RPL for Certificate III in Air Conditioning &amp; Refrigeration (2 Day Assessment).</p>${section('Experience Requirement', '<p>Either one of the following:</p><ol style="padding-left:24px;margin:0;"><li style="margin-bottom:8px;">Licensed Electrician, OR</li><li style="margin-bottom:8px;">Minimum 3 years experience with a signed reference from a licensed air conditioning technician</li></ol>')}${section('Documents Required', airconDocs)}${section('Course Schedule', '<p>Classes will run for 2 days, TBC with trainer.</p>')}${section('Course Fee', priceFmt)}<p>Once we receive and review the above documents, we will be able to confirm your eligibility and proceed with the enrolment process.</p>`,
      },
    };

    const tpl = TEMPLATES[templateType];
    if (!tpl) throw new AppError('Invalid template type', 400);

    const { buildEmailHtml } = require('../services/emailService');
    const html = buildEmailHtml(tpl.content, {
      ctaText: 'Login to Portal',
      ctaUrl: `${baseUrl}/student`,
      preheader: tpl.subject,
    });

    const result = await sendEmail({ to: student.email, subject: tpl.subject, html });
    if (!result.success) throw new AppError('Failed to send email', 500);

    res.status(200).json({ message: 'Predefined email sent successfully', templateType });
  }),
};
