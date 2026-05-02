/**
 * Migration: Add meter fields to billing_usages collection
 *
 * Adds weekKey, meterUsed, meterQuota, planVersion, meterBreakdown,
 * resetAt, alertedAt80, alertedAt100 to existing documents.
 * NOTE: consumedHistoryIds (original field) was renamed to consumedAttributionKeys
 * in migration 20260502100000-rename-consumed-history-ids-to-attribution-keys.js.
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
  // (meterUsed: 0, meterQuota: 0, meterBreakdown: {}, consumedAttributionKeys: []).
  // Existing documents without these fields will use Mongoose defaults on read.
}

/**
 * Down: no-op — indexes are Mongoose-managed; fields are additive (one-way safe).
 * @returns {void}
 */
export function down() {}
