const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const squareWebhookRoutes = require('./routes/webhooks/squareRoutes');
const routes = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Behind Vercel/Render — needed so express-rate-limit / req.ip see the real client IP.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use('/api/webhooks/square', squareWebhookRoutes);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2000,
  })
);

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'certified-australia-backend' });
});

/* ── Email open-tracking pixel (public, unauthenticated) ── */
const PIXEL_HEADERS = {
  'Content-Type': 'image/gif',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

// Sequence (drip) open pixel — two path segments, so it never collides with the
// single-segment campaign pixel below.
app.get('/api/track/seq/:token', async (req, res) => {
  const { TRANSPARENT_GIF } = require('./services/campaignTrackingService');
  const { trackOpen } = require('./services/sequenceTrackingService');
  Promise.resolve(trackOpen(req.params.token)).catch(() => {});
  res.set(PIXEL_HEADERS);
  res.end(TRANSPARENT_GIF);
});

app.get('/api/track/:token', async (req, res) => {
  const { TRANSPARENT_GIF, trackOpen } = require('./services/campaignTrackingService');
  // Never let tracking failures break the pixel response.
  Promise.resolve(trackOpen(req.params.token)).catch(() => {});
  res.set(PIXEL_HEADERS);
  res.end(TRANSPARENT_GIF);
});

/* ── Proxy file endpoint (matches old project /proxy-file) ── */
app.get('/api/proxy-file', async (req, res) => {
  const { url, inline, name } = req.query;
  if (!url) return res.status(400).json({ error: 'url query parameter is required' });

  try {
    const driveService = require('./services/googleDriveService');

    if (driveService.isDriveUrl(url)) {
      const fileId = driveService.extractDriveFileId(url);
      if (!fileId) return res.status(400).json({ error: 'Could not extract Drive file ID from URL' });
      await driveService.streamDriveFileToResponse(fileId, res, inline === '1');
    } else {
      // Fallback: proxy any URL
      const axios = require('axios');
      const response = await axios({ method: 'GET', url, responseType: 'stream' });
      if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
      const disposition = inline === '1' ? 'inline' : 'attachment';
      const fileName = name || 'download';
      res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
      response.data.pipe(res);
    }
  } catch (err) {
    console.error('proxy-file error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to proxy file' });
  }
});

/* ── Signed URL / preview URL endpoint (matches old project /signed-url) ── */
app.get('/api/signed-url', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query parameter is required' });

  try {
    const driveService = require('./services/googleDriveService');

    if (driveService.isDriveUrl(url)) {
      const fileId = driveService.extractDriveFileId(url);
      if (!fileId) return res.status(400).json({ error: 'Could not extract Drive file ID from URL' });
      return res.json({ signedUrl: `https://drive.google.com/file/d/${fileId}/preview` });
    }

    // Non-Drive URLs: return as-is
    return res.json({ signedUrl: url });
  } catch (err) {
    console.error('signed-url error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate signed URL' });
  }
});

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
