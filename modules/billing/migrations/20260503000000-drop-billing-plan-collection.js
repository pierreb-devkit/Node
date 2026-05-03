/**
 * Migration: Drop billingplans collection (config-static refactor)
 *
 * The BillingPlan MongoDB collection is no longer used. Plan definitions
 * are now sourced exclusively from config.billing.planDefinitions (static,
 * version-controlled). This migration drops the collection if it still exists.
 *
 * Safe to run multiple times — dropping a non-existent collection is a no-op.
 *
 * Historical attribution integrity is unaffected: BillingUsage documents store
 * a (planId, planVersion, meterBreakdown) snapshot at attribution time.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const { default: mongoose } = await import('mongoose');
  const db = mongoose.connection.db;

  const collections = await db.listCollections({ name: 'billingplans' }).toArray();
  if (collections.length === 0) {
    return;
  }

  await db.dropCollection('billingplans');
  console.info('[migration] drop-billing-plan-collection: billingplans collection dropped');
}

/**
 * Down: no-op — the collection was owned by the application and seeded at boot.
 * Re-creating it would require re-seeding from config, which is the boot flow
 * prior to this refactor. Rollback requires reverting the code change.
 *
 * @returns {void}
 */
export function down() {
  console.warn(
    '[migration] drop-billing-plan-collection DOWN: no-op; re-seed billingplans by reverting code to pre-config-static',
  );
}
