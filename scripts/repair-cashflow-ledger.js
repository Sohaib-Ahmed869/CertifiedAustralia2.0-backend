/**
 * repair-cashflow-ledger.js
 *
 * One-off (and safely re-runnable) cleanup for the Executive Dashboard →
 * Cashflow tab.
 *
 * Marking a supplier paid used to throw: the composite key written into
 * CashflowWeek.itemsPaid was "tierId.itemId", and Mongoose Maps reject keys
 * containing a dot. The throw happened *after* the debt balance had already
 * been decremented and the ExpenseLedger row written, so every failed click
 * left behind:
 *
 *   - an ExpenseLedger row with no matching paid entry on its week, and
 *   - a CashflowConfig.debtBalances figure reduced for a payment the portal
 *     never actually recorded.
 *
 * This script finds those orphan rows, deletes them, and adds their amounts
 * back onto the matching debt balance. Rows removed by a legitimate "Undo" are
 * already gone, so anything orphaned here is a failed mark-paid.
 *
 * Runs read-only by default — pass --apply to write.
 *
 * Usage (from certfied-australia-v2-be/):
 *   node scripts/repair-cashflow-ledger.js
 *   node scripts/repair-cashflow-ledger.js --apply
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const CashflowConfig = require('../src/models/CashflowConfig');
const CashflowWeek = require('../src/models/CashflowWeek');
const ExpenseLedger = require('../src/models/ExpenseLedger');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function main() {
  const apply = process.argv.includes('--apply');

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set (scripts load .env themselves)');
  await mongoose.connect(uri);

  const weeks = await CashflowWeek.find().lean();
  const paidKeysByWeek = new Map();
  for (const w of weeks) {
    paidKeysByWeek.set(w.weekKey, new Set(
      Object.entries(w.itemsPaid || {})
        .filter(([, v]) => v?.paid)
        // Accept both separators so the check holds whichever era wrote the doc.
        .flatMap(([k]) => [k, k.replace('::', '.'), k.replace('.', '::')])
    ));
  }

  const rows = await ExpenseLedger.find().lean();
  const orphans = rows.filter((r) => {
    const keys = paidKeysByWeek.get(r.weekKey);
    return !keys || !keys.has(`${r.tierId}::${r.itemId}`);
  });

  if (orphans.length === 0) {
    console.log(`No orphan ledger rows found (${rows.length} checked). Nothing to repair.`);
    await mongoose.disconnect();
    return;
  }

  const refundByDebtKey = {};
  for (const r of orphans) {
    console.log(
      `  orphan  ${r.weekKey}  ${r.tierName || r.tierId} / ${r.itemName || r.itemId}` +
      `  $${r.amount}${r.debtKey ? `  (debt: ${r.debtKey})` : ''}`
    );
    if (r.debtKey) {
      refundByDebtKey[r.debtKey] = round2((refundByDebtKey[r.debtKey] || 0) + (r.amount || 0));
    }
  }

  console.log(`\n${orphans.length} orphan ledger row(s), $${round2(orphans.reduce((s, r) => s + (r.amount || 0), 0))} total.`);
  const refunds = Object.entries(refundByDebtKey);
  if (refunds.length) {
    console.log('Debt balances to restore:');
    for (const [key, amount] of refunds) console.log(`  ${key}  +$${amount}`);
  }

  if (!apply) {
    console.log('\nDry run — re-run with --apply to delete the rows and restore the balances.');
    await mongoose.disconnect();
    return;
  }

  const config = await CashflowConfig.findOne().lean();
  const set = { updatedAt: new Date() };
  for (const [key, amount] of refunds) {
    set[`debtBalances.${key}`] = round2((config?.debtBalances?.[key] || 0) + amount);
  }
  if (refunds.length) await CashflowConfig.updateOne({}, { $set: set });
  await ExpenseLedger.deleteMany({ _id: { $in: orphans.map((r) => r._id) } });

  console.log(`\nDeleted ${orphans.length} orphan row(s) and restored ${refunds.length} debt balance(s).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('repair-cashflow-ledger failed:', err);
  process.exit(1);
});
