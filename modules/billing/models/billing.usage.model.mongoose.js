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
    /**
     * Discriminator set ONLY on legacy (non-meter) usage documents — written by
     * BillingUsageRepository.increment's `$setOnInsert`, never by the meter-mode
     * write paths (incrementMeter / upsertWeekSnapshot, which key by weekKey).
     * Exists purely to express "this document has no weekKey" as a SUPPORTED
     * partial-filter condition on the legacy unique index below: MongoDB
     * partial filter expressions do not support `$exists: false` / `$ne` (see
     * that index's comment), so the condition is phrased as a positive
     * `$exists: true` check on a field only legacy documents ever carry.
     */
    legacyPeriod: {
      type: Boolean,
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
 *
 * Partial filter: only applies to legacy (non-meter) documents, identified by
 * the `legacyPeriod` discriminator (see field comment above) rather than by
 * "weekKey is absent" directly. `$exists: false` (and `$ne`) are NOT supported
 * inside a partialFilterExpression — MongoDB only allows `$eq`, `$exists: true`,
 * `$gt`, `$gte`, `$lt`, `$lte`, `$type`, and the top-level `$and`. The previous
 * `{ weekKey: { $exists: false } }` spec silently never built on ANY database:
 * mongoose autoIndex reports the creation failure on the model's unlistened
 * 'index' event, so this uniqueness guard ran on application code alone
 * (upsert-based, racy under a concurrent create) until fixed (#3990). Migration
 * `20260727120000-fix-usage-month-index-partial-filter.js` is the authoritative
 * creator on already-deployed databases (backfills `legacyPeriod` first).
 *
 * Meter-mode documents have weekKey set and can have multiple docs per month
 * (one per ISO week); they never carry `legacyPeriod`, so they stay excluded
 * from this uniqueness constraint.
 */
UsageMongoose.index(
  { organizationId: 1, month: 1 },
  { unique: true, partialFilterExpression: { legacyPeriod: { $exists: true } } },
);

/**
 * Meter-mode unique index: (organizationId, weekKey) — sparse so it only
 * indexes documents that have weekKey populated (meter-mode docs only).
 */
UsageMongoose.index({ organizationId: 1, weekKey: 1 }, { unique: true, sparse: true });

/**
 * TTL index: automatically purge archived usage documents after 1 year.
 *
 * Conditional on archivedAt being set (non-null) — active (non-archived) documents
 * are excluded from this TTL via partialFilterExpression, so only past periods are
 * eligible for purge. The 1-year retention keeps the audit trail long enough for
 * billing reconciliation while preventing unbounded collection growth.
 *
 * Notes:
 *   - The TTL daemon runs once per minute; actual deletion may lag by up to ~1min.
 *   - Verify this index with: db.billingusages.getIndexes() — look for expireAfterSeconds.
 *   - archivedAt is set by archiveOtherWeeks() in the usage repository when the
 *     weekly reset sweep moves old weeks to the archive state.
 */
UsageMongoose.index(
  { archivedAt: 1 },
  {
    expireAfterSeconds: 365 * 24 * 60 * 60,
    partialFilterExpression: { archivedAt: { $type: 'date' } },
  },
);

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
