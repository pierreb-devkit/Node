/**
 * Migration: Add compute fields to billing_usages collection
 *
 * Adds weekKey, computeUsed, computeQuota, planVersion, computeBreakdown,
 * resetAt, alertedAt80, alertedAt100, consumedHistoryIds to existing documents.
 *
 * The (organizationId, weekKey) sparse unique index is owned by the Mongoose
 * schema and synced at bootstrap — do not duplicate it here (name mismatch
 * causes IndexOptionsConflict).
 *
 * Additive only — no data backfill (existing documents keep legacy values).
 * Idempotent: safe to run multiple times.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  // No raw index creation needed: all billingusages indexes are managed by the
  // Mongoose BillingUsage model and auto-synced on connection.
  // No document backfill: new fields have defaults in the Mongoose schema
  // (computeUsed: 0, computeQuota: 0, computeBreakdown: {}, consumedHistoryIds: []).
  // Existing documents without these fields will use Mongoose defaults on read.
}

/**
 * Down: no-op — indexes are Mongoose-managed; fields are additive (one-way safe).
 * @returns {void}
 */
export function down() {}
