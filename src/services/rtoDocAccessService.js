/**
 * RTO document access — signed, submission-scoped links.
 *
 * External RTOs receive document links in the submission email. Those links point
 * back here rather than at Google Drive, so the portal keeps control: a link is only
 * honoured while its submission is the CURRENT one. Sending a new submission sets
 * `superseded` on the previous entries, which closes their links immediately.
 *
 * Tokens are self-describing and stateless — nothing extra is stored per link:
 *   payload = "<submissionId>.<documentId>"   (or "<submissionId>" for the package page)
 *   token   = base64url(payload + "." + hmac(payload))
 *
 * See Docs/RTO-DOC-ACCESS-IMPLEMENTATION-PLAN.md
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const Application = require('../models/Application');
const Document = require('../models/Document');

const SECRET = () => process.env.RTO_DOC_SECRET || process.env.JWT_SECRET || 'ca-rto-doc-access';

const TTL_DAYS = () => {
  const raw = Number(process.env.RTO_DOC_LINK_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
};

/** Public base URL of THIS backend — the links are opened from the RTO's inbox. */
const publicBase = () =>
  (process.env.API_PUBLIC_URL || 'http://localhost:5000').replace(/\/+$/, '');

const linkExpiryFrom = (sentAt = new Date()) =>
  new Date(sentAt.getTime() + TTL_DAYS() * 24 * 60 * 60 * 1000);

/* ── Token ── */

const sign = (payload) =>
  crypto.createHmac('sha256', SECRET()).update(payload).digest('hex').slice(0, 32);

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

/**
 * @param {string} submissionId  rtoSubmissions subdoc _id
 * @param {string} [documentId]  omit for a whole-package token
 */
function makeToken(submissionId, documentId) {
  const payload = documentId ? `${submissionId}.${documentId}` : String(submissionId);
  return b64url(`${payload}.${sign(payload)}`);
}

/** Verify + decode. Returns null on any tampering — never throws. */
function parseToken(token) {
  try {
    const decoded = Buffer.from(String(token), 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length < 2 || parts.length > 3) return null;

    const sig = parts.pop();
    const payload = parts.join('.');
    const expected = sign(payload);

    // Constant-time compare — lengths are fixed, so a mismatch here is tampering.
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

    const [submissionId, documentId] = payload.split('.');
    if (!mongoose.isValidObjectId(submissionId)) return null;
    if (documentId && !mongoose.isValidObjectId(documentId)) return null;

    return { submissionId, documentId: documentId || null };
  } catch (_) {
    return null;
  }
}

const buildDocUrl = (submissionId, documentId) =>
  `${publicBase()}/api/rto-docs/${makeToken(submissionId, documentId)}`;

const buildPackageUrl = (submissionId) =>
  `${publicBase()}/api/rto-docs/pkg/${makeToken(submissionId)}`;

/* ── Access decision ── */

/**
 * Resolve a token to a servable document (or a reason it was refused).
 *
 * @returns {Promise<{ok:true, application, submission, document}
 *                 | {ok:false, reason:'notfound'|'superseded'|'revoked'|'expired'}>}
 */
async function resolveAccess(token) {
  const parsed = parseToken(token);
  if (!parsed) return { ok: false, reason: 'notfound' };

  const application = await Application.findOne(
    { 'rtoSubmissions._id': parsed.submissionId },
    { applicationId: 1, rtoSubmissions: 1, studentId: 1, qualificationId: 1 }
  ).lean();
  if (!application) return { ok: false, reason: 'notfound' };

  const submission = (application.rtoSubmissions || []).find(
    (s) => String(s._id) === String(parsed.submissionId)
  );
  if (!submission) return { ok: false, reason: 'notfound' };

  // Order matters: report the most informative reason first. "A newer package was
  // sent" is actionable for the RTO; "expired" is not.
  if (submission.superseded) return { ok: false, reason: 'superseded' };
  if (submission.revokedAt) return { ok: false, reason: 'revoked' };
  if (submission.expiresAt && new Date(submission.expiresAt) <= new Date()) {
    return { ok: false, reason: 'expired' };
  }

  if (!parsed.documentId) return { ok: true, application, submission, document: null };

  // The document must have been part of THIS submission — a valid token for one
  // document must not be editable into a link for another student's file.
  const inSubmission = (submission.documentIds || []).some(
    (id) => String(id) === String(parsed.documentId)
  );
  if (!inSubmission) return { ok: false, reason: 'notfound' };

  const document = await Document.findById(parsed.documentId).lean();
  if (!document) return { ok: false, reason: 'notfound' };

  return { ok: true, application, submission, document };
}

/* ── Access log (fire-and-forget; never blocks the response) ── */

async function logAccess(applicationId, submissionId, documentId, req) {
  try {
    await Application.updateOne(
      { _id: applicationId, 'rtoSubmissions._id': submissionId },
      {
        $push: {
          'rtoSubmissions.$.accessLog': {
            $each: [
              {
                documentId: documentId || undefined,
                at: new Date(),
                ip: req?.ip,
                userAgent: String(req?.get?.('user-agent') || '').slice(0, 300),
              },
            ],
            // Cap the array — an RTO refreshing a page must not grow the document.
            $slice: -200,
          },
        },
      }
    );
  } catch (err) {
    console.error('[RTODocAccess] logAccess failed:', err.message);
  }
}

/* ── Manual revoke ── */

async function revokeSubmission(applicationId, submissionId, userId) {
  const result = await Application.updateOne(
    { _id: applicationId, 'rtoSubmissions._id': submissionId },
    {
      $set: {
        'rtoSubmissions.$.revokedAt': new Date(),
        'rtoSubmissions.$.revokedBy': userId || null,
      },
    }
  );
  return result.matchedCount > 0;
}

module.exports = {
  makeToken,
  parseToken,
  buildDocUrl,
  buildPackageUrl,
  resolveAccess,
  logAccess,
  revokeSubmission,
  linkExpiryFrom,
  TTL_DAYS,
};
