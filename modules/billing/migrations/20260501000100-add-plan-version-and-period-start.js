/**
 * Migration: Add planVersion to subscriptions + TTL index on processedstripeevents
 *
 * - subscriptions: sparse index on planVersion
 * - processedstripeevents: TTL index on processedAt (30d retention)
 *
 * billingplans indexes are owned by Mongoose schema and synced at bootstrap.
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

  // billingplans indexes are managed by Mongoose (auto-sync on bootstrap).
  // Do not duplicate them here — mismatched names cause IndexOptionsConflict.

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
