const fs = require('fs');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const Application = require('../models/Application');
const Document = require('../models/Document');
const driveService = require('../services/googleDriveService');

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
  'images': 'Other',
  'videos': 'Other',
};

const resolveDocType = (fieldName) => DOC_TYPE_MAP[fieldName] || 'Other';

/* Ensure the application has a Google Drive folder */
const ensureDriveFolder = async (application) => {
  if (application.googleDriveFolderId) return application.googleDriveFolderId;

  let studentName = '';
  if (application.populated('studentId') || typeof application.studentId === 'object') {
    const s = application.studentId;
    studentName = `${s.firstName || ''} ${s.lastName || ''}`.trim();
  }

  const folder = await driveService.createApplicationFolder({
    applicationId: application.applicationId,
    studentName,
  });

  application.googleDriveFolderId = folder.id;
  await application.save();
  return folder.id;
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

  const application = await Application.findById(appId).populate('studentId');
  if (!application) { cleanupFile(file.path); throw new AppError('Application not found', 404); }

  const folderId = await ensureDriveFolder(application);
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
    fileName: file.originalname,
    fileType: mime,
    googleDriveFileId: driveFile.id,
    googleDriveLink: driveFile.webViewLink,
    documentType: resolveDocType(fieldName),
    uploadedBy: req.user?._id || application.studentId._id || application.studentId,
    rtoAccessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  if (!application.documentIds.includes(document._id)) {
    application.documentIds.push(document._id);
    await application.save();
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
