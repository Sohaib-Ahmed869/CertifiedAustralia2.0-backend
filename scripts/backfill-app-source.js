/**
 * Backfill sourceAttribution on existing Applications from their Student's sourceAttribution.
 *
 * Run once after deploying the sourceAttribution field on Application model:
 *   node scripts/backfill-app-source.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Application = require('../src/models/Application');
const Student = require('../src/models/Student');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Find all students that have sourceAttribution set
  const students = await Student.find({
    'sourceAttribution.source': { $exists: true, $ne: null, $ne: '' },
  }).select('_id sourceAttribution').lean();

  console.log(`Found ${students.length} students with sourceAttribution`);

  let updated = 0;
  for (const student of students) {
    // Update all applications for this student that don't already have sourceAttribution
    const result = await Application.updateMany(
      {
        studentId: student._id,
        $or: [
          { 'sourceAttribution.source': { $exists: false } },
          { 'sourceAttribution.source': null },
          { 'sourceAttribution.source': '' },
        ],
      },
      { $set: { sourceAttribution: student.sourceAttribution } }
    );
    if (result.modifiedCount > 0) {
      updated += result.modifiedCount;
      console.log(`  Updated ${result.modifiedCount} apps for student ${student._id} → source: ${student.sourceAttribution.source}`);
    }
  }

  console.log(`\nDone. Updated ${updated} applications total.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
