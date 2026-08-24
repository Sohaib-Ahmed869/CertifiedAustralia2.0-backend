const fs = require('fs');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const Application = require('../models/Application');
const Document = require('../models/Document');
const driveService = require('../services/googleDriveService');
const { autoResolveOnReupload } = require('../services/documentFeedbackService');

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'video/mp4', 'video/quicktime',
]);

const SIZE_LIMITS = {
  image: 40 * 1024 * 1024,       // 40 MB
  video: 5 * 1024 * 1024 * 1024, // 5 GB
  document: 40 * 1024 * 1024,    // 40 MB
};

const getCategory = (mime) => {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  return 'document';
};

const getSizeLimit = (mime) => SIZE_LIMITS[getCategory(mime)];

const cleanupFile = (filePath) => {
  fs.unlink(filePath, () => {});
};

/* Map frontend section names to Document.documentType enum */
const DOC_TYPE_MAP = {
  "Driver's License": 'Identity Verification',
  'ID Card': 'Identity Verification',
  'Passport': 'Identity Verification',
  'Birth Certificate': 'Identity Verification',
  'Medicare Card': 'Identity Verification',
  'Credit Card': 'Identity Verification',
  'Australian Citizenship': 'Identity Verification',
  'USI VET Transcript': 'Educational Qualifications',
  'White Card': 'Educational Qualifications',
  'Previous Qualifications': 'Educational Qualifications',
  'Resume': 'Work Experience Certificate',
  'Employment Letter': 'Work Experience Certificate',
  'Reference One': 'Reference Letter',
  'Reference Two': 'Reference Letter',
  'Payslips/Invoices': 'Work Experience Certificate',
  'SWMS': 'Work Experience Certificate',
  'images': 'Other',
  'videos': 'Other',
};

const resolveDocType = (fieldName) => DOC_TYPE_MAP[fieldName] || 'Other';

/* Ensure the application has a Google Drive folder (uses cache + dedup like old project) */
const ensureDriveFolder = async (application) => {
  if (application.googleDriveFolderId) return application.googleDriveFolderId;

  let studentName = '';
  if (application.populated('studentId') || typeof application.studentId === 'object') {
    const s = application.studentId;
    studentName = `${s.firstName || ''} ${s.lastName || ''}`.trim();
  }

  // Get qualification code/name if populated
  let qualCode = '';
  if (application.populated('qualificationId') || typeof application.qualificationId === 'object') {
    const q = application.qualificationId;
    qualCode = q?.code || q?.name || '';
  }

  // Build a descriptive folder name: APP10000 - John Smith - CPC30220
  const parts = [application.applicationId];
  if (studentName) parts.push(studentName);
  if (qualCode) parts.push(qualCode);
  const folderName = parts.join(' - ');

  // getOrCreateAppFolder checks cache first, then searches Drive, then creates
  const folderId = await driveService.getOrCreateAppFolder(
    application.applicationId,
    folderName,
  );

  application.googleDriveFolderId = folderId;
  // Targeted $set rather than a full save() — parallel uploads each hold their
  // own copy of the application doc, so saving the whole thing could clobber a
  // sibling request's writes.
  await Application.updateOne({ _id: application._id }, { $set: { googleDriveFolderId: folderId } });
  return folderId;
};

/* ── Upload single file ── */
const uploadSingle = asyncHandler(async (req, res) => {
  const { id: appId } = req.params;
  const { fieldName } = req.body;

  if (!req.file) throw new AppError('No file provided', 400);
  if (!fieldName) { cleanupFile(req.file.path); throw new AppError('fieldName is required', 400); }

  const file = req.file;
  const mime = file.mimetype === 'application/octet-stream' && /\.heic$/i.test(file.originalname)
    ? 'image/heic' : file.mimetype;

  if (!ALLOWED_MIME.has(mime)) {
    cleanupFile(file.path);
    throw new AppError(`File type ${mime} is not allowed`, 400);
  }

  if (file.size > getSizeLimit(mime)) {
    cleanupFile(file.path);
    throw new AppError(`File exceeds size limit`, 400);
  }

  const application = await Application.findById(appId).populate('studentId').populate('qualificationId', 'name code');
  if (!application) { cleanupFile(file.path); throw new AppError('Application not found', 404); }

  let folderId = await ensureDriveFolder(application);

  // Separate subfolders for initial vs additional submissions (CA-14)
  const additionalDocRequestId = req.body.additionalDocRequestId;
  if (additionalDocRequestId) {
    // Additional doc requests go into dated subfolders
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const subfolder = await driveService.createSubmissionSubfolder({
        parentFolderId: folderId,
        name: `Additional - ${dateStr}`,
      });
      folderId = subfolder.id;
    } catch {
      // Fall back to root application folder if subfolder creation fails
    }
  } else {
    // Initial submissions go into "Initial Submission" subfolder
    try {
      const subfolder = await driveService.createSubmissionSubfolder({
        parentFolderId: folderId,
        name: 'Initial Submission',
      });
      folderId = subfolder.id;
    } catch {
      // Fall back to root application folder
    }
  }

  const driveName = `${fieldName}_${crypto.randomUUID()}_${file.originalname}`;

  const driveFile = await driveService.uploadFileFromDisk({
    filePath: file.path,
    fileName: driveName,
    mimeType: mime,
    folderId,
  });

  cleanupFile(file.path);

  // Check for existing document with same fieldName for versioning (CA-14)
  const existingDoc = await Document.findOne({
    applicationId: appId,
    fieldName,
    ...(additionalDocRequestId ? { additionalDocRequestId } : { additionalDocRequestId: { $exists: false } }),
  }).sort({ version: -1 }).lean();

  const prevVersion = existingDoc?.version || 0;
  const prevFileIds = existingDoc?.previousVersionFileIds || [];
  if (existingDoc?.googleDriveFileId) {
    prevFileIds.push(existingDoc.googleDriveFileId);
  }

  const docData = {
    applicationId: appId,
    studentId: application.studentId._id || application.studentId,
    fieldName,
    fileName: file.originalname,
    fileType: mime,
    googleDriveFileId: driveFile.id,
    googleDriveLink: driveFile.webViewLink,
    documentType: resolveDocType(fieldName),
    uploadedBy: req.user?._id || application.studentId._id || application.studentId,
    uploadedOnBehalf: req.body.uploadedOnBehalf === 'true' || req.body.uploadedOnBehalf === true,
    rtoAccessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    version: prevVersion + 1,
    previousVersionFileIds: prevFileIds,
  };

  // Link document to an additional doc request if specified (CA-08 gated upload)
  if (additionalDocRequestId) {
    docData.additionalDocRequestId = additionalDocRequestId;
  }

  const document = await Document.create(docData);

  // $addToSet is atomic, so uploads running in parallel each append their own id
  // without one overwriting the other's (a read-modify-save would).
  await Application.updateOne({ _id: appId }, { $addToSet: { documentIds: document._id } });

  // Link document to the additional doc request's documentIds array
  if (additionalDocRequestId) {
    await Application.updateOne(
      { _id: appId, 'additionalDocRequests._id': additionalDocRequestId },
      { $addToSet: { 'additionalDocRequests.$.documentIds': document._id } }
    );
  }

  // Auto-resolve any active feedback on this document field
  if (fieldName) {
    try { await autoResolveOnReupload(appId, fieldName); } catch {}
  }

  res.status(201).json({
    item: document,
    fileUrl: driveFile.webViewLink,
  });
});

/* ── Upload multiple files ── */
const uploadMultiple = asyncHandler(async (req, res) => {
  const { id: appId } = req.params;
  const { fieldName } = req.body;

  if (!req.files?.length) throw new AppError('No files provided', 400);
  if (!fieldName) {
    req.files.forEach((f) => cleanupFile(f.path));
    throw new AppError('fieldName is required', 400);
  }

  const application = await Application.findById(appId).populate('studentId');
  if (!application) {
    req.files.forEach((f) => cleanupFile(f.path));
    throw new AppError('Application not found', 404);
  }

  const folderId = await ensureDriveFolder(application);
  const results = [];

  for (const file of req.files) {
    const mime = file.mimetype === 'application/octet-stream' && /\.heic$/i.test(file.originalname)
      ? 'image/heic' : file.mimetype;

    if (!ALLOWED_MIME.has(mime) || file.size > getSizeLimit(mime)) {
      cleanupFile(file.path);
      continue;
    }

    const driveName = `${fieldName}_${crypto.randomUUID()}_${file.originalname}`;

    const driveFile = await driveService.uploadFileFromDisk({
      filePath: file.path,
      fileName: driveName,
      mimeType: mime,
      folderId,
    });

    cleanupFile(file.path);

    const document = await Document.create({
      applicationId: appId,
      studentId: application.studentId._id || application.studentId,
      fieldName,
      fileName: file.originalname,
      fileType: mime,
      googleDriveFileId: driveFile.id,
      googleDriveLink: driveFile.webViewLink,
      documentType: resolveDocType(fieldName),
      uploadedBy: req.user?._id || application.studentId._id || application.studentId,
      rtoAccessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    application.documentIds.push(document._id);
    results.push(document);
  }

  await application.save();

  res.status(201).json({ items: results });
});

/* ── Delete a document ── */
const deleteDocument = asyncHandler(async (req, res) => {
  const { id: appId, docId } = req.params;

  const document = await Document.findById(docId);
  if (!document) throw new AppError('Document not found', 404);

  if (document.googleDriveFileId) {
    await driveService.deleteFile(document.googleDriveFileId).catch(() => {});
  }

  await Document.findByIdAndDelete(docId);

  await Application.findByIdAndUpdate(appId, {
    $pull: { documentIds: docId },
  });

  res.status(200).json({ message: 'Document deleted' });
});

/* ── List documents for an application ── */
const listDocuments = asyncHandler(async (req, res) => {
  const { id: appId } = req.params;

  const documents = await Document.find({ applicationId: appId })
    .sort({ uploadedAt: -1 })
    .lean();

  res.status(200).json({ items: documents });
});

module.exports = {
  uploadSingle,
  uploadMultiple,
  deleteDocument,
  listDocuments,
};
