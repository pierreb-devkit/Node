/**
 * Migration: Add planVersion and currentPeriodStart to subscriptions collection
 *
 * Schema changes (new fields + indexes on subscriptions, billingplans,
 * processedstripeevents) are owned by the respective Mongoose models and
 * auto-synced at bootstrap (autoIndex: true).
 *
 * This migration is a marker: it records the point at which these fields
 * were introduced so rollback tooling can target the correct state.
 *
 * Additive only — no data backfill.
 * Idempotent: safe to run multiple times.
 *
 * @returns {void}
 */
export function up() {}

/**
 * Down: no-op — indexes are Mongoose-managed; fields are additive (one-way safe).
 * @returns {void}
 */
export function down() {}
