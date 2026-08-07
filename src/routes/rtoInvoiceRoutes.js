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
  if (req.file && googleDriveService) {
    try {
      const result = await googleDriveService.uploadFileFromDisk({
        filePath: req.file.path,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
      });
      data.originalFileName = req.file.originalname;
      data.originalFileUrl = result.webViewLink;
      data.googleDriveFileId = result.id;
    } finally {
      // Clean up temp file
      fs.unlink(req.file.path, () => {});
    }
  } else if (req.file) {
    // No Google Drive configured — store file name only
    data.originalFileName = req.file.originalname;
    fs.unlink(req.file.path, () => {});
  }

  const item = await rtoInvoiceService.createInvoice(data);
  res.status(201).json({ item });
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

// Delete invoice
router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await rtoInvoiceService.remove(req.params.id);
  res.json(result);
}));

module.exports = router;
