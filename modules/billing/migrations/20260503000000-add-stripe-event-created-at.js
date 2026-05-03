/**
 * Migration: Add stripeEventCreatedAt field to subscriptions collection
 *
 * Additive only — no backfill needed. The webhook guard uses
 * `$or: [{ stripeEventCreatedAt: null }, { stripeEventCreatedAt: { $lt: event.created } }]`
 * so existing documents (null) accept the first event unconditionally.
 *
 * Idempotent: safe to run multiple times.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  // No raw index creation needed: the Mongoose Subscription model owns
  // the schema definition; Mongoose syncs indexes at bootstrap.
  // No document backfill: existing docs with stripeEventCreatedAt=null
  // are handled by the $exists: false / null branch in webhook guards.
}

/**
 * Down: no-op — field is additive and backward-compatible.
 * @returns {void}
 */
export function down() {}
