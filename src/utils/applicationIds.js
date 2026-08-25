/**
 * Normalise a mixed list of application identifiers into Application `_id`s.
 *
 * The "Specific Recipients" pickers (email campaigns + sequences) send whatever
 * the picked search-result row carried, which is routinely the human display id
 * (`APP95959`) rather than the Mongo `_id`. Both `audienceConfig.includeApplicationIds`
 * fields are typed `[ObjectId]`, so a display id blows up at save time with a
 * CastError — before the audience is ever resolved. The legacy portal's
 * `audienceResolver.js` deliberately accepted both forms; this keeps that contract.
 *
 * Ids that resolve to nothing are dropped: a deleted application can't be mailed,
 * and one stale row must not fail the whole send.
 */
const mongoose = require('mongoose');
const Application = require('../models/Application');

// Deliberately stricter than mongoose.isValidObjectId, which accepts ANY
// 12-character string and would silently mangle a display id of that length.
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * @param {Array<string|mongoose.Types.ObjectId>|string} value
 * @returns {Promise<mongoose.Types.ObjectId[]>} deduped ObjectIds, input order preserved
 */
const normalizeApplicationIds = async (value) => {
  const list = (Array.isArray(value) ? value : [value])
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map((v) => (typeof v === 'string' ? v.trim() : v))
    .filter(Boolean);
  if (!list.length) return [];

  const displayIds = list.filter(
    (v) => !(v instanceof mongoose.Types.ObjectId) && !OBJECT_ID_RE.test(String(v)),
  ).map(String);

  const byDisplayId = new Map();
  if (displayIds.length) {
    const rows = await Application.find({ applicationId: { $in: displayIds } })
      .select('_id applicationId')
      .lean();
    for (const row of rows) byDisplayId.set(row.applicationId, row._id);
  }

  const seen = new Set();
  const out = [];
  for (const v of list) {
    let id = null;
    if (v instanceof mongoose.Types.ObjectId) id = v;
    else if (OBJECT_ID_RE.test(String(v))) id = new mongoose.Types.ObjectId(String(v));
    else id = byDisplayId.get(String(v)) || null;
    if (!id) continue; // unknown display id — drop it rather than fail the send
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
};

module.exports = { normalizeApplicationIds };
