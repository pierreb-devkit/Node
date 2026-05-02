/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Data Model Mongoose
 *
 * Legacy fields (organizationId, month, counters) are always present.
 * Meter fields (weekKey, meterUsed, etc.) are sparse/optional — only
 * populated when config.billing.meterMode is true. This ensures full
 * backward compatibility for non-meter downstream projects.
 *
 * NOTE — Mixed type caveats (applies to 'counters' and 'meterBreakdown' fields):
 *   Mongoose validators are NOT executed for in-place mutations on Mixed fields
 *   (doc.field.x = y; doc.save() silently skips validators).
 *   Always use atomic MongoDB operators ($inc, $set via findOneAndUpdate)
 *   or Model.create() which runs validators on the full document.
 */
const UsageMongoose = new Schema(
  {
    organizationId: {
      type: Schema.ObjectId,
      ref: 'Organization',
      required: true,
    },
    month: {
      type: String,
      required: true,
      index: true,
    },
    counters: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },

    // ── Meter fields (sparse — only populated in meter mode) ─────────────────

    /**
     * ISO week key in YYYY-Www format (e.g. "2026-W18").
     * Used as the primary period key when meterMode is enabled.
     */
    weekKey: {
      type: String,
      sparse: true,
    },
    /**
     * Total meter units consumed this week.
     */
    meterUsed: {
      type: Number,
      default: 0,
    },
    /**
     * Snapshot of the plan's meterQuota at week start.
     * Avoids retroactive plan change effects mid-week.
     */
    meterQuota: {
      type: Number,
      default: 0,
    },
    /**
     * The plan version that was active when this week started.
     */
    planVersion: {
      type: String,
      sparse: true,
    },
    /**
     * Free-form breakdown of meter units by feature bucket.
     * Example: { scrap: 100, autofix: 50, wizard: 200 }
     */
    meterBreakdown: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },
    /**
     * When the current meter period resets.
     */
    resetAt: {
      type: Date,
      sparse: true,
    },
    /**
     * Timestamp when the 80% threshold alert was sent (null = not yet sent).
     */
    alertedAt80: {
      type: Date,
      default: null,
    },
    /**
     * Timestamp when the 100% threshold alert was sent (null = not yet sent).
     */
    alertedAt100: {
      type: Date,
      default: null,
    },
    /**
     * Timestamp when this usage period was archived by the reset sweep.
     */
    archivedAt: {
      type: Date,
      default: null,
    },
    /**
     * Per-step attribution keys consumed this period, in `${historyId}:${stepKey}` format.
     * Legacy raw ObjectId strings (before per-step idempotency) are stored as `${id}:initial`.
     * Used for idempotent attribution checks — indexed for future $in / $elemMatch queries.
     */
    consumedAttributionKeys: {
      type: [String],
      default: () => [],
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Legacy unique index: (organizationId, month) — kept for non-meter downstream.
 * Partial filter: only applies to documents without weekKey (non-meter mode).
 * Meter-mode documents have weekKey set and can have multiple docs per month
 * (one per ISO week), so they are excluded from this uniqueness constraint.
 */
UsageMongoose.index(
  { organizationId: 1, month: 1 },
  { unique: true, partialFilterExpression: { weekKey: { $exists: false } } },
);

/**
 * Meter-mode unique index: (organizationId, weekKey) — sparse so it only
 * indexes documents that have weekKey populated (meter-mode docs only).
 */
UsageMongoose.index({ organizationId: 1, weekKey: 1 }, { unique: true, sparse: true });

/**
 * Returns the hex string representation of the document ObjectId.
 * @returns {string} Hex string of the ObjectId.
 */
function addID() {
  return this._id.toHexString();
}

/**
 * Model configuration
 */
UsageMongoose.virtual('id').get(addID);
// Ensure virtual fields are serialised.
UsageMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('BillingUsage', UsageMongoose);
