/**
 * Migration: Add planVersion and currentPeriodStart to subscriptions collection
 *
 * Also ensures the billingplans and processedstripeevents collections have
 * their required indexes.
 *
 * Additive only — no data backfill.
 * Idempotent: safe to run multiple times.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const { db } = await import('mongoose').then((m) => ({ db: m.default.connection.db }));

  // ── subscriptions: sparse index for planVersion ─────────────────────────
  const subscriptions = db.collection('subscriptions');
  await subscriptions.createIndex(
    { planVersion: 1 },
    { sparse: true, name: 'planVersion_sparse' },
  );

  // ── billingplans: create indexes if collection doesn't already have them ──
  const billingplans = db.collection('billingplans');
  await billingplans.createIndex(
    { planId: 1, version: 1 },
    { unique: true, name: 'planId_version_unique' },
  );
  await billingplans.createIndex(
    { planId: 1, active: 1, effectiveUntil: 1 },
    { name: 'planId_active_effectiveUntil' },
  );

  // ── processedstripeevents: TTL index ─────────────────────────────────────
  const events = db.collection('processedstripeevents');
  await events.createIndex(
    { processedAt: 1 },
    { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'processedAt_ttl_30d' },
  );
}

/**
 * Down: remove the added sparse index from subscriptions.
 * Does NOT remove fields or drop the new collections.
 * @returns {Promise<void>}
 */
export async function down() {
  const { db } = await import('mongoose').then((m) => ({ db: m.default.connection.db }));
  const subscriptions = db.collection('subscriptions');

  try {
    await subscriptions.dropIndex('planVersion_sparse');
  } catch (err) {
    if (err?.codeName !== 'IndexNotFound' && err?.code !== 27) throw err;
  }
}
