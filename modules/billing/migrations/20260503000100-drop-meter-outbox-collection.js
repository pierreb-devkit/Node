/**
 * Migration: Drop billingmeteroutboxes collection (atomic inline debit refactor)
 *
 * The BillingMeterOutbox collection is no longer used. The outbox pattern for
 * extras debit has been replaced by an inline atomic debit call inside
 * incrementMeter with non-fatal error handling. This migration drops the
 * collection and any pending retry documents.
 *
 * Any pending outbox documents at the time this migration runs are safe to
 * discard: extras already attributed against usage are eventually reconcilable
 * via the BillingExtraBalance ledger. Do not run while the retry cron is active.
 *
 * Safe to run multiple times — dropping a non-existent collection is a no-op.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const { default: mongoose } = await import('mongoose');
  const db = mongoose.connection.db;

  const collections = await db.listCollections({ name: 'billingmeteroutboxes' }).toArray();
  if (collections.length === 0) {
    return;
  }

  const count = await db.collection('billingmeteroutboxes').countDocuments();
  if (count > 0) {
    console.warn(
      `[migration] drop-meter-outbox-collection: ${count} pending outbox documents will be discarded`,
    );
  }

  await db.dropCollection('billingmeteroutboxes');
  console.info('[migration] drop-meter-outbox-collection: billingmeteroutboxes collection dropped');
}

/**
 * Down: no-op — the outbox pattern is removed at the code level.
 * Restoring the collection without the retry cron and service has no effect.
 * Rollback requires reverting the code change.
 *
 * @returns {void}
 */
export function down() {
  console.warn(
    '[migration] drop-meter-outbox-collection DOWN: no-op; restore billingmeteroutboxes by reverting code to pre-inline-debit',
  );
}
