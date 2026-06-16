/**
 * migrate-to-live.js
 * -------------------
 * Migrates ALL data from a local (source) MongoDB to a live (target) MongoDB.
 *
 * Usage:
 *   node src/migrate-to-live.js
 *
 * Environment variables (set in .env or pass inline):
 *   SOURCE_MONGODB_URI  — local / source database URI
 *                         defaults to: mongodb://127.0.0.1:27017/certified_australia
 *   TARGET_MONGODB_URI  — live / target database URI  (REQUIRED — no default)
 *
 * What it does:
 *   1. Connects to both databases using the native MongoClient (no Mongoose models,
 *      so documents are copied byte-for-byte with no schema transforms).
 *   2. Lists every collection in the source database.
 *   3. For each collection it:
 *        a. Reads ALL documents.
 *        b. Drops the matching collection in the target (clean slate per collection).
 *        c. Inserts all documents in ordered batches of 500.
 *        d. Copies every index from source → target (skips the default _id index).
 *   4. Runs a verification pass: compares document counts per collection.
 *   5. Prints a summary table.
 *
 * Safety:
 *   - The script asks for confirmation before touching the target.
 *   - It uses ordered inserts so any failure stops the batch immediately.
 *   - _id values are preserved exactly (ObjectId, string, etc.).
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SOURCE_URI =
  process.env.SOURCE_MONGODB_URI ||
  'mongodb://127.0.0.1:27017/certified_australia';

const TARGET_URI = process.env.TARGET_MONGODB_URI;

if (!TARGET_URI) {
  console.error(
    '\n  ERROR: TARGET_MONGODB_URI is required.\n' +
      '  Set it in .env or pass it inline:\n\n' +
      '    TARGET_MONGODB_URI="mongodb+srv://..." node src/migrate-to-live.js\n'
  );
  process.exit(1);
}

const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    })
  );
}

function padRight(str, len) {
  return String(str).padEnd(len);
}

function printTable(rows) {
  // rows = [{ collection, sourceCount, targetCount, status }]
  const colWidths = { collection: 30, sourceCount: 14, targetCount: 14, status: 10 };
  const header =
    padRight('Collection', colWidths.collection) +
    padRight('Source Count', colWidths.sourceCount) +
    padRight('Target Count', colWidths.targetCount) +
    padRight('Status', colWidths.status);
  const sep = '-'.repeat(header.length);
  console.log('\n' + sep);
  console.log(header);
  console.log(sep);
  for (const r of rows) {
    console.log(
      padRight(r.collection, colWidths.collection) +
        padRight(r.sourceCount, colWidths.sourceCount) +
        padRight(r.targetCount, colWidths.targetCount) +
        padRight(r.status, colWidths.status)
    );
  }
  console.log(sep);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function migrate() {
  console.log('=== Certified Australia — DB Migration ===\n');
  console.log(`  Source : ${SOURCE_URI.replace(/\/\/.*@/, '//<credentials>@')}`);
  console.log(`  Target : ${TARGET_URI.replace(/\/\/.*@/, '//<credentials>@')}`);
  console.log();

  // Confirmation
  const answer = await ask(
    '  This will DROP and REPLACE all collections in the target database.\n' +
      '  Type "yes" to continue: '
  );
  if (answer !== 'yes') {
    console.log('\n  Aborted.');
    process.exit(0);
  }

  // Connect
  const sourceClient = new MongoClient(SOURCE_URI);
  const targetClient = new MongoClient(TARGET_URI);

  try {
    await sourceClient.connect();
    console.log('\n  Connected to SOURCE database.');

    await targetClient.connect();
    console.log('  Connected to TARGET database.');

    const sourceDb = sourceClient.db();
    const targetDb = targetClient.db();

    // List collections (skip system collections)
    const collections = (await sourceDb.listCollections().toArray())
      .filter((c) => !c.name.startsWith('system.'))
      .map((c) => c.name)
      .sort();

    if (collections.length === 0) {
      console.log('\n  No collections found in source database. Nothing to migrate.');
      return;
    }

    console.log(`\n  Found ${collections.length} collections to migrate:\n`);
    collections.forEach((name) => console.log(`    - ${name}`));
    console.log();

    const results = [];

    for (const collName of collections) {
      process.stdout.write(`  Migrating "${collName}" ...`);

      const sourceColl = sourceDb.collection(collName);
      const targetColl = targetDb.collection(collName);

      // 1. Read all documents from source
      const docs = await sourceColl.find({}).toArray();
      const sourceCount = docs.length;

      // 2. Drop the target collection (clean slate)
      try {
        await targetColl.drop();
      } catch (err) {
        // Collection may not exist yet — that's fine
        if (err.codeName !== 'NamespaceNotFound') throw err;
      }

      // 3. Insert documents in batches
      if (docs.length > 0) {
        for (let i = 0; i < docs.length; i += BATCH_SIZE) {
          const batch = docs.slice(i, i + BATCH_SIZE);
          await targetColl.insertMany(batch, { ordered: true });
        }
      }

      // 4. Copy indexes (skip the default _id index)
      const indexes = await sourceColl.indexes();
      for (const idx of indexes) {
        if (idx.name === '_id_') continue; // default index is auto-created
        const { key, ...options } = idx;
        // Remove fields that cannot be passed to createIndex
        delete options.v;
        delete options.ns;
        try {
          await targetColl.createIndex(key, options);
        } catch (err) {
          console.warn(`\n    Warning: could not create index "${idx.name}" on "${collName}": ${err.message}`);
        }
      }

      // 5. Verify count
      const targetCount = await targetColl.countDocuments();
      const match = sourceCount === targetCount;

      results.push({
        collection: collName,
        sourceCount,
        targetCount,
        status: match ? 'OK' : 'MISMATCH',
      });

      process.stdout.write(` ${sourceCount} docs → ${match ? 'OK' : 'MISMATCH'}\n`);
    }

    // Summary
    printTable(results);

    const mismatches = results.filter((r) => r.status !== 'OK');
    if (mismatches.length === 0) {
      console.log('\n  Migration completed successfully. All counts match.\n');
    } else {
      console.error(
        `\n  WARNING: ${mismatches.length} collection(s) have count mismatches!\n`
      );
      process.exitCode = 1;
    }
  } finally {
    await sourceClient.close();
    await targetClient.close();
  }
}

migrate().catch((err) => {
  console.error('\n  FATAL:', err);
  process.exit(1);
});
