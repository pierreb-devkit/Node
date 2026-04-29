/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Data Model Mongoose
 *
 * Legacy fields (organizationId, month, counters) are always present.
 * Compute fields (weekKey, computeUsed, etc.) are sparse/optional — only
 * populated when config.billing.computeMode is true. This ensures full
 * backward compatibility for non-compute downstream projects.
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

    // ── Compute fields (sparse — only populated in compute mode) ─────────────

    /**
     * ISO week key in YYYY-Www format (e.g. "2026-W18").
     * Used as the primary period key when computeMode is enabled.
     */
    weekKey: {
      type: String,
      sparse: true,
    },
    /**
     * Total compute units consumed this week.
     */
    computeUsed: {
      type: Number,
      default: 0,
    },
    /**
     * Snapshot of the plan's computeQuota at week start.
     * Avoids retroactive plan change effects mid-week.
     */
    computeQuota: {
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
     * Free-form breakdown of compute units by feature bucket.
     * Example: { scrap: 100, autofix: 50, wizard: 200 }
     */
    computeBreakdown: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },
    /**
     * When the current compute period resets.
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
     * ObjectIds of History documents consumed (attributed) this period.
     * Used for idempotent attribution checks.
     */
    consumedHistoryIds: {
      type: [Schema.ObjectId],
      default: () => [],
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Legacy unique index: (organizationId, month) — kept for non-compute downstream.
 * sparse: false is the Mongoose default; month is always present on legacy docs.
 */
UsageMongoose.index({ organizationId: 1, month: 1 }, { unique: true });

/**
 * Compute-mode unique index: (organizationId, weekKey) — sparse so it only
 * indexes documents that have weekKey populated (compute-mode docs only).
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
