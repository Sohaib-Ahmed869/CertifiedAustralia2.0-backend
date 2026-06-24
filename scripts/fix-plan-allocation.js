/**
 * Fix Plan Allocation Script
 *
 * Re-allocates all completed plan payments to their payment plan installments.
 * Fixes corrupted data from the old buggy allocateToPlan that used spread copies.
 *
 * Usage:  node scripts/fix-plan-allocation.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Payment = require('../src/models/Payment');
const PaymentPlan = require('../src/models/PaymentPlan');

async function fixAllPlans() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const plans = await PaymentPlan.find({ status: { $ne: 'cancelled' } });
  console.log(`Found ${plans.length} active payment plan(s)\n`);

  for (const plan of plans) {
    console.log(`── Plan ${plan._id} (App: ${plan.applicationId}) ──`);

    // Reset all installments to fresh state
    for (const inst of plan.installments) {
      inst.paidAmount = 0;
      inst.status = 'pending';
      inst.paymentIds = [];
      inst.paymentDate = undefined;
    }
    plan.totalPaidAmount = 0;
    plan.status = 'active';

    // Find all completed plan-type payments linked to this plan or this application
    const payments = await Payment.find({
      $or: [
        { paymentPlanId: plan._id },
        { applicationId: plan.applicationId, type: 'plan' },
      ],
      status: 'completed',
    }).sort({ createdAt: 1 });

    console.log(`  Found ${payments.length} completed plan payment(s)`);

    // Re-allocate each payment sequentially
    for (const pmt of payments) {
      let remaining = Number(pmt.amount);
      const sorted = plan.installments.sort((a, b) => a.index - b.index);

      for (const installment of sorted) {
        if (remaining <= 0) break;
        if (installment.status === 'paid' || installment.status === 'skipped') continue;

        const alreadyPaid = Number(installment.paidAmount || 0);
        const outstanding = Math.max(0, Number(installment.amount) - alreadyPaid);
        if (outstanding <= 0) {
          installment.status = 'paid';
          continue;
        }

        const applied = Math.min(outstanding, remaining);
        installment.paidAmount = alreadyPaid + applied;
        if (!installment.paymentIds) installment.paymentIds = [];
        installment.paymentIds.push(pmt._id);
        remaining -= applied;

        if (installment.paidAmount >= installment.amount) {
          installment.status = 'paid';
          installment.paymentDate = pmt.createdAt;
        } else {
          installment.status = 'partiallyPaid';
        }
      }

      plan.totalPaidAmount = Number(plan.totalPaidAmount || 0) + Number(pmt.amount - remaining);
    }

    if (plan.totalPaidAmount >= plan.totalAmount) {
      plan.status = 'completed';
    }

    // Print results
    for (const inst of plan.installments) {
      console.log(`  #${inst.index + 1}: $${inst.amount} → paid $${inst.paidAmount} [${inst.status}]`);
    }
    console.log(`  Total paid: $${plan.totalPaidAmount} / $${plan.totalAmount} → ${plan.status}\n`);

    plan.markModified('installments');
    await plan.save();
    console.log(`  ✓ Saved\n`);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

fixAllPlans().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
