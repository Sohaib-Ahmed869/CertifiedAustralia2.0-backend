/**
 * Import competency checklists + reference letter templates from the LEGACY
 * Firebase (Firestore) portal into the current MongoDB portal, replacing any
 * existing checklist / reference letter we already have for a qualification.
 *
 * These are the same per-qualification "Add Checklist" / "Ref Letter" records
 * shown one-by-one on the Admin → Qualifications page.
 *
 * SOURCE (legacy Firestore, project "certifiedaustralia1"):
 *   competencyChecklists     { qualificationId (lowercased name), qualificationName,
 *                              units: [{ unitCode, unitTitle, evidenceItems: [] }] }
 *   referenceLetterTemplates { qualificationId (lowercased name), qualificationName,
 *                              templateName, fileUrl (Firebase Storage), fileName, fileType }
 *
 * TARGET (current MongoDB):
 *   Checklist                { qualificationId, industryId, rawText, units[] }
 *                            + Qualification.checklistId back-link
 *   ReferenceLetterTemplate  { qualificationId, fileName, fileType, googleDriveFileId,
 *                              googleDriveLink, version } + Qualification.referenceLetterTemplateId
 *   Reference-letter FILES are re-hosted: downloaded from Firebase Storage and
 *   re-uploaded to Google Drive (the current portal's file store).
 *
 * MATCHING: legacy qualificationId (a lowercased qualification name) → current
 * Qualification.name, normalized (lower/trim/collapse-spaces). Falls back to the
 * qualification code prefix (e.g. "aur40820") when the full name differs slightly.
 * Legacy "industry_*" general checklists are NOT per-qualification and are skipped.
 *
 * USAGE (run from the backend root, so .env + Google creds resolve):
 *   node scripts/import-legacy-checklists-refletters.js                 # dry run — reports, writes nothing
 *   node scripts/import-legacy-checklists-refletters.js --confirm       # apply changes
 *   node scripts/import-legacy-checklists-refletters.js --confirm --only=checklists
 *   node scripts/import-legacy-checklists-refletters.js --confirm --only=refletters
 *   node scripts/import-legacy-checklists-refletters.js --confirm --limit=3   # process first N of each (testing)
 *
 * This overwrites existing checklists/templates for matched qualifications. Take a
 * mongodump before running with --confirm.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const mongoose = require('mongoose');

// ── Legacy Firebase (loaded from the OLD project's own node_modules + key) ──
const OLD_BE = path.resolve(
  __dirname,
  '..', '..',
  'Old project', 'CertifiedAustralia', 'CertifiedAustraliaBE'
);
const admin = require(path.join(OLD_BE, 'node_modules', 'firebase-admin'));
const legacyServiceAccount = require(path.join(OLD_BE, 'serviceAccountKey.json'));

// ── Current portal models + Drive service ──
const Qualification = require('../src/models/Qualification');
const Checklist = require('../src/models/Checklist');
const ReferenceLetterTemplate = require('../src/models/ReferenceLetterTemplate');
const driveService = require('../src/services/googleDriveService');

// ── CLI flags ──
const CONFIRM = process.argv.includes('--confirm');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || 'all';
const LIMIT = parseInt((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1], 10) || 0;
const DO_CHECKLISTS = ONLY === 'all' || ONLY === 'checklists';
const DO_REFLETTERS = ONLY === 'all' || ONLY === 'refletters';

// ── Helpers ──
const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
const codeOf = (s) => {
  const m = norm(s).match(/^[a-z]{2,4}\d{4,6}/);
  return m ? m[0] : null;
};

const ALLOWED_TYPES = ['doc', 'docx', 'pdf'];
const MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const resolveFileType = (fileType, fileName) => {
  const t = (fileType || '').toLowerCase().trim();
  if (ALLOWED_TYPES.includes(t)) return t;
  const ext = (fileName || '').split('.').pop().toLowerCase();
  return ALLOWED_TYPES.includes(ext) ? ext : null;
};

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Add it to .env before running.');
    process.exit(1);
  }

  // Connect Firestore (legacy) + Mongo (current)
  admin.initializeApp({
    credential: admin.credential.cert(legacyServiceAccount),
    storageBucket: 'gs://certifiedaustralia1.appspot.com',
  });
  const fbdb = admin.firestore();

  await mongoose.connect(process.env.MONGODB_URI);
  const { host, name } = mongoose.connection;
  console.log(`Connected — legacy Firestore "certifiedaustralia1" → MongoDB "${name}" on ${host}`);
  console.log(CONFIRM ? '\nMODE: --confirm (writing changes)\n' : '\nDRY RUN — nothing will be written. Re-run with --confirm to apply.\n');

  // Build qualification lookup: normalized name + code prefix → Qualification
  const quals = await Qualification.find({}).select('name industryId checklistId referenceLetterTemplateId').lean();
  const byName = new Map();
  const byCode = new Map();
  for (const q of quals) {
    byName.set(norm(q.name), q);
    const c = codeOf(q.name);
    if (c && !byCode.has(c)) byCode.set(c, q);
  }
  console.log(`Loaded ${quals.length} qualifications from MongoDB.\n`);

  const matchQual = (legacyQualId) => {
    const exact = byName.get(norm(legacyQualId));
    if (exact) return exact;
    const c = codeOf(legacyQualId);
    return (c && byCode.get(c)) || null;
  };

  const summary = {
    checklists: { matched: 0, skippedGeneral: 0, unmatched: [] },
    refletters: { matched: 0, uploaded: 0, unmatched: [], failed: [] },
  };

  // ─────────────────────────── CHECKLISTS ───────────────────────────
  if (DO_CHECKLISTS) {
    console.log('── Competency checklists ──');
    let docs = (await fbdb.collection('competencyChecklists').get()).docs;
    if (LIMIT) docs = docs.slice(0, LIMIT);

    for (const doc of docs) {
      const data = doc.data();
      const legacyQualId = data.qualificationId || '';

      if (legacyQualId.startsWith('industry_')) {
        summary.checklists.skippedGeneral++;
        console.log(`  ~ skip (industry-general, not per-qualification): ${legacyQualId}`);
        continue;
      }

      const qual = matchQual(legacyQualId);
      if (!qual) {
        summary.checklists.unmatched.push(legacyQualId);
        console.log(`  ✗ no qualification match: "${legacyQualId}"`);
        continue;
      }

      const units = (data.units || []).map((u) => ({
        unitCode: u.unitCode || '',
        unitTitle: u.unitTitle || '',
        evidenceItems: (u.evidenceItems || []).filter(Boolean),
      }));

      summary.checklists.matched++;
      const existed = !!qual.checklistId;
      console.log(`  ✓ ${qual.name}  (${units.length} units)${existed ? '  [replacing existing]' : ''}`);

      if (!CONFIRM) continue;

      let checklist = await Checklist.findOne({ qualificationId: qual._id });
      if (checklist) {
        checklist.industryId = qual.industryId;
        checklist.rawText = data.rawText || '';
        checklist.units = units;
        checklist.updatedAt = new Date();
        await checklist.save();
      } else {
        checklist = await Checklist.create({
          qualificationId: qual._id,
          industryId: qual.industryId,
          rawText: data.rawText || '',
          units,
        });
      }
      // Ensure back-link is set/correct
      if (String(qual.checklistId || '') !== String(checklist._id)) {
        await Qualification.findByIdAndUpdate(qual._id, { checklistId: checklist._id });
      }
    }
    console.log('');
  }

  // ────────────────────── REFERENCE LETTER TEMPLATES ──────────────────────
  if (DO_REFLETTERS) {
    console.log('── Reference letter templates ──');
    let docs = (await fbdb.collection('referenceLetterTemplates').get()).docs;
    if (LIMIT) docs = docs.slice(0, LIMIT);

    for (const doc of docs) {
      const data = doc.data();
      const legacyQualId = data.qualificationId || '';

      const qual = matchQual(legacyQualId);
      if (!qual) {
        summary.refletters.unmatched.push(legacyQualId);
        console.log(`  ✗ no qualification match: "${legacyQualId}"`);
        continue;
      }

      const fileType = resolveFileType(data.fileType, data.fileName);
      if (!fileType) {
        summary.refletters.failed.push(`${legacyQualId} (bad type "${data.fileType}")`);
        console.log(`  ✗ unsupported file type for "${legacyQualId}": ${data.fileType}`);
        continue;
      }
      if (!data.fileUrl) {
        summary.refletters.failed.push(`${legacyQualId} (no fileUrl)`);
        console.log(`  ✗ no file attached for "${legacyQualId}"`);
        continue;
      }

      summary.refletters.matched++;
      const existed = !!qual.referenceLetterTemplateId;
      console.log(`  ✓ ${qual.name}  (${data.fileName})${existed ? '  [replacing existing]' : ''}`);

      if (!CONFIRM) continue;

      try {
        // 1. Download the file from legacy Firebase Storage
        const resp = await fetch(data.fileUrl);
        if (!resp.ok) throw new Error(`download HTTP ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());

        // 2. Re-host on Google Drive (current portal's file store)
        const driveFile = await driveService.uploadFileBuffer({
          buffer,
          fileName: `ref_template_${qual._id}_${(data.fileName || 'reference_letter').replace(/\s+/g, '_')}`,
          mimeType: MIME[fileType],
          description: `Reference letter template for ${qual.name} (imported from legacy portal)`,
        });

        // 3. Upsert the template record, replacing the old file
        let template = await ReferenceLetterTemplate.findOne({ qualificationId: qual._id });
        const oldDriveId = template && template.googleDriveFileId;

        if (template) {
          template.fileName = data.fileName || 'reference_letter.docx';
          template.fileType = fileType;
          template.googleDriveFileId = driveFile.id;
          template.googleDriveLink = driveFile.webViewLink;
          template.version = (template.version || 0) + 1;
          template.notes = 'Imported from legacy portal';
          template.uploadedAt = new Date();
          template.updatedAt = new Date();
          await template.save();
        } else {
          template = await ReferenceLetterTemplate.create({
            qualificationId: qual._id,
            fileName: data.fileName || 'reference_letter.docx',
            fileType,
            googleDriveFileId: driveFile.id,
            googleDriveLink: driveFile.webViewLink,
            notes: 'Imported from legacy portal',
          });
        }

        // 4. Back-link + clean up the replaced Drive file
        if (String(qual.referenceLetterTemplateId || '') !== String(template._id)) {
          await Qualification.findByIdAndUpdate(qual._id, { referenceLetterTemplateId: template._id });
        }
        if (oldDriveId && oldDriveId !== driveFile.id) {
          await driveService.deleteFile(oldDriveId).catch(() => {});
        }

        summary.refletters.uploaded++;
      } catch (err) {
        summary.refletters.failed.push(`${legacyQualId} (${err.message})`);
        console.log(`    ! failed to import file for "${legacyQualId}": ${err.message}`);
      }
    }
    console.log('');
  }

  // ─────────────────────────── SUMMARY ───────────────────────────
  console.log('── Summary ──');
  if (DO_CHECKLISTS) {
    const c = summary.checklists;
    console.log(`  Checklists : ${c.matched} matched${CONFIRM ? ' & written' : ''}, ${c.skippedGeneral} industry-general skipped, ${c.unmatched.length} unmatched`);
    c.unmatched.forEach((x) => console.log(`      unmatched: ${x}`));
  }
  if (DO_REFLETTERS) {
    const r = summary.refletters;
    console.log(`  Ref letters: ${r.matched} matched${CONFIRM ? `, ${r.uploaded} re-hosted & written` : ''}, ${r.unmatched.length} unmatched, ${r.failed.length} failed`);
    r.unmatched.forEach((x) => console.log(`      unmatched: ${x}`));
    r.failed.forEach((x) => console.log(`      failed:    ${x}`));
  }
  if (!CONFIRM) console.log('\nDry run complete. No changes made. Re-run with --confirm to apply.');
  else console.log('\nDone.');

  // Graceful teardown (avoids firebase-admin gRPC libuv assertion on abrupt exit)
  await mongoose.disconnect();
  await admin.app().delete().catch(() => {});
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
