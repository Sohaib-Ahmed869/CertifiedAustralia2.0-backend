const mongoose = require('mongoose');

/**
 * AD CAMPAIGN — one paid push on one marketing source.
 *
 * NAMED `AdCampaign`, NOT `Campaign`. `Campaign` is already taken by the EMAIL
 * campaign feature (Campaign / CampaignRecipient / campaignSendService), which
 * is a completely unrelated system: that one sends mail to a resolved audience,
 * this one is a tracking dimension on the public register URL. Do not conflate
 * them and do not "tidy" the name.
 *
 * THE PROBLEM IT SOLVES. `?source=tiktok` proves the platform but not the ad.
 * Certified Australia runs several concurrent pushes per platform, and until now
 * every one of them landed in the same TikTok bucket — so a campaign that paid
 * for itself and one that did not were indistinguishable. A campaign adds the
 * second dimension: `?source=tiktok&campaign=summer_sale`.
 *
 * ONE CAMPAIGN BELONGS TO ONE SOURCE (`sourceKey`). The same creative run on
 * TikTok and Facebook is two rows, each with its own link, image and spend —
 * that is the client's decision, and it is why every rollup can treat a campaign
 * as a strict subdivision of its platform rather than something that spans them.
 *
 * THE KEY IS GLOBALLY UNIQUE, not unique-per-source. It is the attribution
 * itself and, because it is unique, it also RESOLVES its own source — so a link
 * that lost its `?source=` (or carries a contradictory one) still attributes
 * correctly. `adCampaignService.resolveAttribution` is where that is enforced.
 * Like `MarketingSource.key` it is immutable after create: leads already carry
 * the string, so re-keying would orphan their history. Rename `name` instead.
 */
const adCampaignSchema = new mongoose.Schema(
  {
    /**
     * The `MarketingSource.key` this campaign runs on. Stored as the KEY, not an
     * ObjectId, to match how attribution is stored everywhere else in this
     * feature (`sourceAttribution.source`, `MarketingSpend.platform`) — a join
     * on a string key is what every existing marketing aggregation already does.
     */
    sourceKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    /** The `?campaign=` value. Immutable after create — see the class comment. */
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    /** Display name, e.g. "Summer Sale 2026". Freely renamable. */
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    /**
     * The ad creative, on Google Drive via the service account (same path as
     * every other upload in the portal). Only the file id is stored: the display
     * URL is derived as `drive.google.com/thumbnail?id=…`, which is what the
     * document previews on student detail already use, so no new serving
     * infrastructure is involved. `uploadFileFromDisk` sets public-read on it.
     */
    image: {
      fileId: { type: String, trim: true, default: '' },
      fileName: { type: String, trim: true, default: '' },
      mimeType: { type: String, trim: true, default: '' },
      uploadedAt: { type: Date },
    },
    /**
     * Retiring a campaign is a deactivation, not a delete — the same rule the
     * source registry uses. An inactive campaign stops being offered for new
     * links and drops out of the spend editor, but is STILL labelled and STILL
     * counted in every rollup, or ending a campaign would retroactively erase
     * the leads and revenue it produced.
     */
    isActive: {
      type: Boolean,
      default: true,
    },
    order: {
      type: Number,
      default: 100,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// Globally unique key (see the class comment on why it is not per-source).
// Declared here only, never also as `index: true` on the field, or Mongoose logs
// a duplicate-index warning at boot. A collision surfaces as a readable 409 via
// errorHandler's 11000 mapping.
adCampaignSchema.index({ key: 1 }, { unique: true });
adCampaignSchema.index({ sourceKey: 1, isActive: 1, order: 1 });

module.exports = mongoose.model('AdCampaign', adCampaignSchema);
