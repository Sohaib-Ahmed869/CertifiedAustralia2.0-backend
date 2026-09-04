const express = require('express');
const fs = require('fs');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const upload = require('../middleware/upload');
const rtoInvoiceService = require('../services/rtoInvoiceService');
const invoiceParserService = require('../services/invoiceParserService');

let googleDriveService;
try { googleDriveService = require('../services/googleDriveService'); } catch { /* optional */ }

const router = express.Router();

router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

/**
 * Push an attached file to Drive and return the fields the invoice stores for
 * it. Shared by create and replace so both paths land the file the same way.
 * Always unlinks the temp file, even when Drive is unavailable.
 */
const storeUploadedFile = async (file) => {
  try {
    if (!googleDriveService) return { originalFileName: file.originalname };
    const result = await googleDriveService.uploadFileFromDisk({
      filePath: file.path,
      fileName: file.originalname,
      mimeType: file.mimetype,
    });
    return {
      originalFileName: file.originalname,
      originalFileUrl: result.webViewLink,
      googleDriveFileId: result.id,
    };
  } finally {
    fs.unlink(file.path, () => {});
  }
};

// Parse an uploaded invoice file and return extracted fields (DEXT-style).
// Does NOT persist anything — the frontend uses this to pre-fill the upload form,
// then the user reviews and submits POST / with the same file as usual.
router.post('/parse', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  try {
    const buffer = fs.readFileSync(req.file.path);
    const extracted = await invoiceParserService.parseInvoiceBuffer(buffer, req.file.mimetype);
    // Don't ship the full raw text back to the client — keep the payload lean.
    const { raw, ...fields } = extracted;
    res.json({ extracted: fields });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}));

// List invoices
router.get('/', asyncHandler(async (req, res) => {
  const result = await rtoInvoiceService.list(req.query);
  res.json(result);
}));

// Get single invoice
router.get('/:id', asyncHandler(async (req, res) => {
  const item = await rtoInvoiceService.getById(req.params.id);
  res.json({ item });
}));

// Create/upload invoice (supports optional file attachment)
router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  const data = { ...req.body, uploadedBy: req.user._id };

  // Handle file upload to Google Drive if a file was attached
  if (req.file) {
    Object.assign(data, await storeUploadedFile(req.file));
  }

  const item = await rtoInvoiceService.createInvoice(data);
  res.status(201).json({ item });
}));

// Correct an invoice uploaded in error: edit its details and/or replace the
// attached file. Keeps the invoice record, its batch row and the application's
// state intact — use DELETE when the invoice should not exist at all.
router.patch('/:id', upload.single('file'), asyncHandler(async (req, res) => {
  // Two ways a replacement file arrives: attached here (finance page), or
  // already uploaded through the documents pipeline and passed by reference
  // (student detail page, which files the invoice under the student's docs too).
  let file = null;
  if (req.file) {
    file = await storeUploadedFile(req.file);
  } else if (req.body.googleDriveFileId || req.body.originalFileUrl) {
    file = {
      originalFileName: req.body.originalFileName,
      originalFileUrl: req.body.originalFileUrl,
      googleDriveFileId: req.body.googleDriveFileId,
      documentId: req.body.documentId,
    };
  }

  const item = await rtoInvoiceService.update(req.params.id, req.body, {
    file,
    actor: req.user,
  });
  res.json({ item });
}));

// Verify invoice (confirm extracted data + map to application)
router.patch('/:id/verify', asyncHandler(async (req, res) => {
  const item = await rtoInvoiceService.verify(req.params.id, {
    ...req.body,
    verifiedBy: req.user._id,
  });
  res.json({ item });
}));

// Schedule into weekly batch
router.patch('/:id/schedule', asyncHandler(async (req, res) => {
  const item = await rtoInvoiceService.schedule(req.params.id, req.body.weekKey);
  res.json({ item });
}));

// Mark as paid
router.patch('/:id/paid', asyncHandler(async (req, res) => {
  const item = await rtoInvoiceService.markPaid(req.params.id);
  res.json({ item });
}));

// Reject invoice
router.patch('/:id/reject', asyncHandler(async (req, res) => {
  const item = await rtoInvoiceService.reject(req.params.id, {
    rejectedBy: req.user._id,
    reason: req.body.reason,
  });
  res.json({ item });
}));

// Auto-map to application
router.post('/:id/auto-map', asyncHandler(async (req, res) => {
  const result = await rtoInvoiceService.autoMap(req.params.id);
  res.json(result);
}));

// Remove an invoice uploaded in error. Unwinds the whole upload: unqueues it
// from its batch week, reverts the application's status, restarts the 21-day
// timer, reverses the auto-created RTO payable and deletes the file.
router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await rtoInvoiceService.remove(req.params.id, {
    reason: req.body?.reason,
    actor: req.user,
  });
  res.json(result);
}));

module.exports = router;
