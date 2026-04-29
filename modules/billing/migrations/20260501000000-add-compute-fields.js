/**
 * Migration: Add compute fields to billing_usages collection
 *
 * Adds weekKey, computeUsed, computeQuota, planVersion, computeBreakdown,
 * resetAt, alertedAt80, alertedAt100, consumedHistoryIds to existing documents.
 *
 * Additive only — no data backfill (existing documents keep legacy values).
 * Idempotent: safe to run multiple times.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const { db } = await import('mongoose').then((m) => ({ db: m.default.connection.db }));
  const collection = db.collection('billingusages');

  // Add sparse index for weekKey — only indexes docs where weekKey exists.
  // createIndex is idempotent: no-op if the index already exists.
  await collection.createIndex(
    { organizationId: 1, weekKey: 1 },
    { unique: true, sparse: true, name: 'organizationId_weekKey_unique_sparse' },
  );

  // No document backfill: new fields have defaults in the Mongoose schema
  // (computeUsed: 0, computeQuota: 0, computeBreakdown: {}, consumedHistoryIds: []).
  // Existing documents without these fields will use Mongoose defaults on read.
}

/**
 * Down: remove the weekKey sparse index.
 * Does NOT remove fields (additive migrations are one-way safe).
 * @returns {Promise<void>}
 */
export async function down() {
  const { db } = await import('mongoose').then((m) => ({ db: m.default.connection.db }));
  const collection = db.collection('billingusages');

  try {
    await collection.dropIndex('organizationId_weekKey_unique_sparse');
  } catch (err) {
    // Index may not exist — ignore "index not found" errors
    if (err?.codeName !== 'IndexNotFound' && err?.code !== 27) throw err;
  }
}
