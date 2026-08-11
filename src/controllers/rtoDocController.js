/**
 * Public endpoints backing the signed document links in RTO submission emails.
 *
 * These are mounted in app.js BEFORE the authenticated `/api` router — external RTOs
 * have no portal account. Authorisation comes entirely from the signed token plus the
 * submission's state (current / not revoked / not expired).
 *
 * Responses are HTML, not JSON: an RTO assessor clicks these from their inbox.
 */

const rtoDocAccess = require('../services/rtoDocAccessService');
const driveService = require('../services/googleDriveService');
const { T } = require('../services/emailService');

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'rpl@certifiedaustralia.com.au';

/* ── Branded notice page (mirrors the email palette) ── */

const noticePage = ({ title, message, tone = 'neutral' }) => {
  const accent = tone === 'expired' ? T.warning : T.textMuted;
  const accentBg = tone === 'expired' ? T.warningBg : '#f3f5f4';
  const accentBorder = tone === 'expired' ? T.warningBorder : T.dividerColor;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title} &middot; Certified Australia</title>
</head>
<body style="margin:0;padding:0;background:${T.pageBg};font-family:${T.fontStack};">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="min-height:100vh;">
    <tr><td align="center" style="padding:48px 20px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:520px;background:${T.cardBg};border-radius:${T.cardBorderRadius};box-shadow:${T.cardShadow};overflow:hidden;">
        <tr><td align="center" style="padding:28px 32px 22px;background:${T.headerGradient};">
          <img src="${T.logoUrl}" alt="Certified Australia" width="132" style="display:block;border:0;max-width:132px;height:auto;">
        </td></tr>
        <tr><td style="padding:34px 36px 30px;">
          <div style="width:44px;height:44px;border-radius:50%;background:${accentBg};border:1px solid ${accentBorder};text-align:center;line-height:44px;font-size:20px;color:${accent};margin-bottom:18px;">&#9888;</div>
          <h1 style="margin:0 0 12px;font-size:19px;font-weight:700;color:${T.textPrimary};letter-spacing:-0.3px;line-height:1.35;">${title}</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:${T.textSecondary};">${message}</p>
          <p style="margin:0;font-size:13px;line-height:1.7;color:${T.textTertiary};">
            Need assistance? Contact us at
            <a href="mailto:${SUPPORT_EMAIL}" style="color:${T.primary};text-decoration:none;font-weight:600;">${SUPPORT_EMAIL}</a>.
          </p>
        </td></tr>
        <tr><td align="center" style="padding:18px 32px;background:${T.footerGradient};border-top:1px solid ${T.primaryBorder};">
          <p style="margin:0;font-size:12px;color:${T.textTertiary};">&copy; ${new Date().getFullYear()} Certified Australia. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
};

const DENIALS = {
  superseded: {
    status: 410,
    title: 'This document link has expired',
    message:
      'A more recent version of this application has been sent to you. Please refer to the latest email from Certified Australia to access the current documents.',
    tone: 'expired',
  },
  expired: {
    status: 410,
    title: 'This document link has expired',
    message: `Document access is available for ${rtoDocAccess.TTL_DAYS()} days from submission. Please contact our team if you still require these documents.`,
    tone: 'expired',
  },
  revoked: {
    status: 410,
    title: 'Access has been withdrawn',
    message:
      'Access to this application package has been withdrawn by Certified Australia. Please contact our team if you believe this is an error.',
    tone: 'expired',
  },
  notfound: {
    status: 404,
    title: 'This link is not valid',
    message:
      'The link you followed could not be found. It may have been altered or copied incompletely — please open it directly from the original email.',
    tone: 'neutral',
  },
};

const sendDenial = (res, reason) => {
  const d = DENIALS[reason] || DENIALS.notfound;
  return res
    .status(d.status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .send(noticePage(d));
};

/* ── GET /api/rto-docs/:token — stream one document ── */

const serveDocument = async (req, res) => {
  let result;
  try {
    result = await rtoDocAccess.resolveAccess(req.params.token);
  } catch (err) {
    console.error('[RTODocs] resolve failed:', err.message);
    return sendDenial(res, 'notfound');
  }

  if (!result.ok) return sendDenial(res, result.reason);
  if (!result.document) return sendDenial(res, 'notfound');

  const { document, application, submission } = result;
  const fileId =
    document.googleDriveFileId || driveService.extractDriveFileId(document.googleDriveLink || '');
  if (!fileId) return sendDenial(res, 'notfound');

  // Never cache: a superseded link must stop working on the very next click.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('X-Robots-Tag', 'noindex, nofollow');

  // Fire-and-forget — access logging must never delay or break the download.
  rtoDocAccess.logAccess(application._id, submission._id, document._id, req).catch(() => {});

  try {
    await driveService.streamDriveFileToResponse(fileId, res, true);
  } catch (err) {
    console.error('[RTODocs] stream failed for doc %s:', document._id, err.message);
    if (!res.headersSent) sendDenial(res, 'notfound');
    else res.end();
  }
};

/* ── GET /api/rto-docs/pkg/:token — index of everything in one submission ── */

const servePackage = async (req, res) => {
  let result;
  try {
    result = await rtoDocAccess.resolveAccess(req.params.token);
  } catch (err) {
    console.error('[RTODocs] package resolve failed:', err.message);
    return sendDenial(res, 'notfound');
  }

  if (!result.ok) return sendDenial(res, result.reason);

  const { application, submission } = result;
  const Document = require('../models/Document');
  const documents = await Document.find({ _id: { $in: submission.documentIds || [] } }).lean();

  const rows = documents
    .map((d) => {
      const label = d.fieldName || d.documentType || 'Document';
      const url = rtoDocAccess.buildDocUrl(submission._id, d._id);
      return `<tr>
        <td style="padding:11px 0;border-bottom:1px solid ${T.dividerColor};font-size:12px;color:${T.textTertiary};font-weight:600;text-transform:uppercase;letter-spacing:0.4px;width:38%;vertical-align:top;">${label}</td>
        <td style="padding:9px 0 9px 16px;border-bottom:1px solid ${T.dividerColor};vertical-align:top;">
          <a href="${url}" style="color:${T.primary};text-decoration:none;font-size:14px;font-weight:500;">&#128196; ${d.fileName || 'Document'}</a>
        </td></tr>`;
    })
    .join('');

  const expiryNote = submission.expiresAt
    ? `These links remain available until ${new Date(submission.expiresAt).toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' })}, or until a newer submission is sent.`
    : 'These links close automatically when a newer submission is sent.';

  res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex, nofollow');
  rtoDocAccess.logAccess(application._id, submission._id, null, req).catch(() => {});

  return res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Application ${application.applicationId} &middot; Supporting Documents</title>
</head>
<body style="margin:0;padding:0;background:${T.pageBg};font-family:${T.fontStack};">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    <tr><td align="center" style="padding:44px 20px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:640px;background:${T.cardBg};border-radius:${T.cardBorderRadius};box-shadow:${T.cardShadow};overflow:hidden;">
        <tr><td align="center" style="padding:26px 32px 20px;background:${T.headerGradient};">
          <img src="${T.logoUrl}" alt="Certified Australia" width="132" style="display:block;border:0;max-width:132px;height:auto;">
        </td></tr>
        <tr><td style="padding:30px 34px 28px;">
          <h1 style="margin:0 0 6px;font-size:19px;font-weight:700;color:${T.textPrimary};letter-spacing:-0.3px;">Supporting Documents</h1>
          <p style="margin:0 0 20px;font-size:14px;color:${T.textSecondary};">Application <strong style="color:${T.textPrimary};">${application.applicationId}</strong> &nbsp;&middot;&nbsp; Package v${submission.packageVersion}</p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${rows || `<tr><td style="font-size:14px;color:${T.textTertiary};">No documents are attached to this submission.</td></tr>`}</table>
          <p style="margin:22px 0 0;font-size:12px;line-height:1.7;color:${T.textTertiary};">${expiryNote}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`);
};

module.exports = { serveDocument, servePackage };
