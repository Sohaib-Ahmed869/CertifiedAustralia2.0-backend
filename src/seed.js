require('dotenv').config();
const mongoose = require('mongoose');
const Industry = require('./models/Industry');
const Qualification = require('./models/Qualification');
const seedData = require('./seed-data.json');

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Clear existing
  await Qualification.deleteMany({});
  await Industry.deleteMany({});
  console.log('Cleared existing industries & qualifications');

  let totalQuals = 0;

  for (const ind of seedData.industries) {
    const industry = await Industry.create({
      name: ind.name,
      description: ind.description,
      status: 'active',
    });

    for (const q of ind.qualifications) {
      const rtoCosts = [];
      if (q.rtoName && q.rtoCost > 0) {
        // Handle pipe-separated RTOs like "rto1 | rto2"
        const names = q.rtoName.split('|').map((n) => n.trim()).filter(Boolean);
        const costs = String(q.rtoCost).split('/').map((c) => parseInt(c.replace(/,/g, '').trim()) || 0);
        names.forEach((name, i) => {
          rtoCosts.push({ rtoName: name, rtoCost: costs[i] || costs[0] });
        });
      }

      await Qualification.create({
        name: q.name,
        industryId: industry._id,
        caPrice: q.caPrice,
        rtoCosts,
        status: 'active',
      });
      totalQuals++;
    }

    console.log(`  ${industry.name}: ${ind.qualifications.length} qualifications`);
  }

  console.log(`\nSeeded ${seedData.industries.length} industries, ${totalQuals} qualifications`);
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
