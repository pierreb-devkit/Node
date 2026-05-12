/**
 * Migration: Backfill 500 signup-grant credits to existing Free-plan orgs.
 *
 * Credits every organization currently on the Free plan (plan === 'free')
 * that has not been canceled (status !== 'canceled') and does not already hold
 * a 'signup_grant' ledger entry, mirroring what new Free signups receive via
 * BillingSignupGrantService (N2 — one-shot 500-compute grant).
 *
 * Idempotent: the synthetic idempotency key `signup_grant-<orgId>` stored as
 * `ledger[].refId` is the same key `creditGrant` uses at signup time.
 * Running this migration a second time skips every org (all are already credited).
 *
 * Safe to run while the app is live: each updateOne is atomic (single-document
 * write) and the migration runner serialises execution via a DB-level claim so
 * only one pod runs this at startup even in multi-replica deploys.
 *
 * down() removes all signup_grant ledger entries.  Note: cachedBalance is NOT
 * adjusted on rollback — run a reconcile sweep if down() is invoked in prod.
 */
import mongoose from 'mongoose';

const SIGNUP_GRANT_AMOUNT = 500;
const GRANT_SOURCE = 'signup_grant';

/**
 * @returns {Promise<void>}
 */
export async function up() {
  const db = mongoose.connection.db;
  const subscriptions = db.collection('subscriptions');
  const extraBalances = db.collection('billingextrabalances');

  const cursor = subscriptions.find(
    { plan: 'free', status: { $ne: 'canceled' } },
    { projection: { organization: 1 } },
  );

  let granted = 0;
  let skipped = 0;

  for await (const sub of cursor) {
    const orgId = sub.organization;
    if (!orgId) { skipped += 1; continue; }

    const idempotencyKey = `${GRANT_SOURCE}-${orgId.toString()}`;

    // Skip if this org already has a signup_grant entry (idempotent re-run).
    const existing = await extraBalances.findOne(
      { organization: orgId, 'ledger.refId': idempotencyKey },
      { projection: { _id: 1 } },
    );
    if (existing) { skipped += 1; continue; }

    // Step 1: ensure the ExtraBalance document exists (no-op if already present).
    await extraBalances.updateOne(
      { organization: orgId },
      {
        $setOnInsert: {
          organization: orgId,
          ledger: [],
          cachedBalance: 0,
          cachedBalanceAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );

    // Step 2: push the grant entry (idempotency-guarded, no upsert).
    const result = await extraBalances.updateOne(
      { organization: orgId, 'ledger.refId': { $ne: idempotencyKey } },
      {
        $push: {
          ledger: {
            kind: 'topup',
            amount: SIGNUP_GRANT_AMOUNT,
            source: GRANT_SOURCE,
            refId: idempotencyKey,
            at: new Date(),
          },
        },
        $inc: { cachedBalance: SIGNUP_GRANT_AMOUNT },
        $set: { cachedBalanceAt: new Date(), updatedAt: new Date() },
      },
    );

    if (result.modifiedCount > 0) {
      granted += 1;
    } else {
      // Another concurrent writer beat us to this org — harmless race, already credited.
      skipped += 1;
    }
  }

  console.info(`[migration] grant-backfill: complete — granted=${granted} skipped=${skipped}`);
}

/**
 * Reverse: remove all signup_grant ledger entries.
 *
 * WARNING: cachedBalance is NOT adjusted. If down() is applied to a live
 * database, run a cachedBalance reconcile sweep afterwards.
 *
 * @returns {Promise<void>}
 */
export async function down() {
  const db = mongoose.connection.db;

  const result = await db.collection('billingextrabalances').updateMany(
    { 'ledger.source': GRANT_SOURCE },
    { $pull: { ledger: { source: GRANT_SOURCE } } },
  );

  console.warn(
    `[migration] grant-backfill DOWN: removed signup_grant entries from ${result.modifiedCount} docs. cachedBalance NOT adjusted — run reconcile if applied in prod.`,
  );
}
