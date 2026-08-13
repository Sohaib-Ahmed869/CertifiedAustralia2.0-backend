/**
 * contactTrackingService — keeps Application.contactAttempts / incomingCalls in
 * lockstep with the Call Scorecard (CallEvent).
 *
 * The counters used to be hand-cranked from the Contact Tracking +/- steppers on
 * the student detail page, which meant every call had to be entered twice (once
 * in the Call Log, once on the stepper) and the two drifted apart. They are now
 * DERIVED: every write path that records a real call writes a CallEvent, and
 * this service recomputes the counters from those events.
 *
 *   contactAttempts = CallEvent count (outbound) for the application
 *   incomingCalls   = CallEvent count (incoming) for the application
 *   lastContactedAt = timestamp of the most recent event
 *
 * Recompute-from-source (not $inc) is deliberate: it is idempotent, so a
 * retried webhook or a re-run backfill can never inflate the numbers, and
 * deleting a mis-logged call corrects the counter automatically.
 *
 * Call paths that feed it:
 *   • Manual "Log Call" on the student detail page → callScorecardService.createEvent
 *   • Twilio call bursts + 1-on-1 softphone calls  → callBurstService.writeCallEvents
 *   • Inbound Twilio calls                          → inboundCallService.logScorecardEvent
 *   • Legacy agent-portal call log                  → callLogService.logCall
 */

const mongoose = require('mongoose');
const CallEvent = require('../models/CallEvent');
const Application = require('../models/Application');

function toObjectId(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id);
  return mongoose.Types.ObjectId.isValid(s)
    ? mongoose.Types.ObjectId.createFromHexString(s)
    : null;
}

/**
 * Recompute the contact counters for one application from its CallEvents.
 * Non-throwing by design — call tracking must never break a call flow.
 *
 * @param {string|ObjectId} applicationId
 * @param {object}  [opts]
 * @param {string}  [opts.contactStatus] optional free-text status to stamp alongside
 * @returns {{contactAttempts:number, incomingCalls:number}|null}
 */
async function syncApplication(applicationId, { contactStatus } = {}) {
  const appId = toObjectId(applicationId);
  if (!appId) return null;

  try {
    const [contactAttempts, incomingCalls, latest] = await Promise.all([
      CallEvent.countDocuments({ applicationId: appId, direction: { $ne: 'incoming' } }),
      CallEvent.countDocuments({ applicationId: appId, direction: 'incoming' }),
      CallEvent.findOne({ applicationId: appId })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean(),
    ]);

    const $set = { contactAttempts, incomingCalls };
    // Only move lastContactedAt while events exist — clearing it on the last
    // delete would lose history the counters no longer carry.
    if (latest?.createdAt) $set.lastContactedAt = latest.createdAt;
    if (contactStatus) $set.contactStatus = contactStatus;

    await Application.updateOne({ _id: appId }, { $set });
    return { contactAttempts, incomingCalls };
  } catch (err) {
    console.warn(`[contactTracking] sync failed for ${applicationId}: ${err.message}`);
    return null;
  }
}

/**
 * Recompute every application that has at least one CallEvent, plus reset any
 * application carrying stale hand-entered counters with no events behind them.
 * Used by scripts/resync-contact-attempts.js and safe to re-run.
 */
async function syncAll({ resetOrphans = true } = {}) {
  const grouped = await CallEvent.aggregate([
    { $match: { applicationId: { $ne: null } } },
    {
      $group: {
        _id: '$applicationId',
        contactAttempts: { $sum: { $cond: [{ $eq: ['$direction', 'incoming'] }, 0, 1] } },
        incomingCalls: { $sum: { $cond: [{ $eq: ['$direction', 'incoming'] }, 1, 0] } },
        lastContactedAt: { $max: '$createdAt' },
      },
    },
  ]);

  let synced = 0;
  for (const row of grouped) {
    await Application.updateOne(
      { _id: row._id },
      {
        $set: {
          contactAttempts: row.contactAttempts,
          incomingCalls: row.incomingCalls,
          ...(row.lastContactedAt ? { lastContactedAt: row.lastContactedAt } : {}),
        },
      }
    );
    synced += 1;
  }

  let reset = 0;
  if (resetOrphans) {
    const withEvents = grouped.map((r) => r._id);
    const res = await Application.updateMany(
      {
        _id: { $nin: withEvents },
        $or: [{ contactAttempts: { $gt: 0 } }, { incomingCalls: { $gt: 0 } }],
      },
      { $set: { contactAttempts: 0, incomingCalls: 0 } }
    );
    reset = res.modifiedCount || 0;
  }

  return { synced, reset };
}

module.exports = { syncApplication, syncAll };
