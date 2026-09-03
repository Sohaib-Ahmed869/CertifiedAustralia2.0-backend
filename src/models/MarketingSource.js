const mongoose = require('mongoose');

/**
 * Marketing source registry — the single source of truth for the `?source=` keys
 * carried on the public register URL.
 *
 * The key itself has always been captured free-form (`Application.sourceAttribution.source`
 * is a plain String with no enum, and `authService.register` writes whatever the URL
 * carried). What used to be hardcoded was the *labelling and rollup*: a source that
 * wasn't in the developer-maintained registry still got captured, but rendered as a raw
 * key next to a globe icon and was skipped entirely by the CEO dashboard's platform
 * cards / CPA / ROAS. That registry was declared in ten places across nine files, so
 * adding one link needed a developer and a deploy. This collection replaces all ten.
 *
 * Reserved keys, deliberately NOT rows here:
 *   `direct` — the absence of attribution, computed alongside the platforms.
 *
 * Not to be confused with `howDidYouHear` (self-reported by the student at signup,
 * enum-validated on ScreeningForm). The two disagree routinely and that is expected.
 */
const marketingSourceSchema = new mongoose.Schema(
  {
    /**
     * The `?source=` value. IMMUTABLE after create — every Application and Student
     * already signed up under it stores this exact string, so re-keying a row would
     * orphan its whole history. Rename the `label` instead; that is what is displayed.
     */
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    // Shown on the Marketing Links card so staff know which link to reach for.
    description: {
      type: String,
      trim: true,
      default: '',
    },
    // Hex, drives the badge tint, the link card and every chart series for this source.
    color: {
      type: String,
      trim: true,
      default: '#0a9d42',
    },
    // A NAME from the frontend's icon allow-list (lib/sourceIcons.js), never a component.
    // An unknown name degrades to the generic link glyph rather than breaking a render.
    icon: {
      type: String,
      trim: true,
      default: 'link',
    },
    /**
     * Alternate keys that roll UP into this source when ad spend was logged under them.
     * This is what `SPEND_KEY_TO_SOURCE` used to hardcode: spend booked as `meta` or
     * `meta_paid` still has to land on `facebook`, or a rename silently zeroes a
     * platform's CPA while leaving the money on an orphan key.
     */
    aliases: [{ type: String, trim: true, lowercase: true }],
    /**
     * Seeded rows — the fifteen the portal shipped with. Their `key` and existence are
     * protected (no delete, no re-key) because integrations, saved links and printed
     * QR codes point at them; everything else about them is editable.
     */
    isBuiltIn: {
      type: Boolean,
      default: false,
    },
    /**
     * Retiring a source is a deactivation, not a delete. An inactive source is withdrawn
     * from the places that START new attribution — the link cards, the ad-spend editor,
     * the source pickers — but is STILL labelled and STILL counted by every dashboard
     * rollup, or last quarter's leads would silently vanish from the numbers.
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

// One row per key. Declared here only (never also as `index: true` on the field), or
// Mongoose logs a duplicate-index warning at boot. A collision surfaces as a readable
// 409 via errorHandler's 11000 mapping.
marketingSourceSchema.index({ key: 1 }, { unique: true });
marketingSourceSchema.index({ isActive: 1, order: 1 });

module.exports = mongoose.model('MarketingSource', marketingSourceSchema);
