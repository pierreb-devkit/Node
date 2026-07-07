/**
 * Migration: Backfill the one-shot signupGrant to plan orgs that were created
 * without it.
 *
 * The signupGrant was historically credited only on the invite/verify
 * org-creation path (organizations.service.js::createOrganizationForUser). The
 * generic path behind POST /api/organizations (organizations.crud.service.js)
 * never credited it, so orgs created that way — e.g. via a manual "create
 * workspace" screen — started at 0 balance. The code gap is fixed alongside
 * this migration; this repairs already-affected orgs.
 *
 * Config-driven: for every plan in config.billing.planDefinitions that defines
 * a positive signupGrant, credit that amount to orgs on that plan which have no
 * signup_grant ledger entry yet. A project that configures no signupGrant is a
 * no-op. This generalises the earlier 20260511 backfill, which hardcoded 500
 * and enumerated the `subscriptions` collection (missing free orgs that have no
 * subscription document); this one enumerates the `organizations` collection.
 *
 * Idempotent: the synthetic key `signup_grant-<orgId>` stored as `ledger[].refId`
 * is the exact key `creditGrant` uses at signup time, so an org already credited
 * (at signup, by the earlier migration, or by a prior run of this one) is skipped.
 *
 * The `organization` field on billingextrabalances is stored as a STRING at
 * runtime (see billing.extraBalance schema / repository), so every lookup and
 * write here uses `org._id.toString()` to stay consistent with app writes.
 *
 * Safe to run while the app is live: each updateOne is a single-document atomic
 * write and the migration runner serialises execution via a DB-level claim.
 */
import mongoose from 'mongoose';
import config from '../../../config/index.js';

const GRANT_SOURCE = 'signup_grant';

/**
 * @returns {Promise<void>}
 */
export async function up() {
  const db = mongoose.connection.db;
  const organizations = db.collection('organizations');
  const extraBalances = db.collection('billingextrabalances');

  // planId -> signupGrant amount, for plans that define a positive grant.
  const grantByPlan = new Map();
  for (const def of config?.billing?.planDefinitions ?? []) {
    if (def?.planId && typeof def.signupGrant === 'number' && def.signupGrant > 0) {
      grantByPlan.set(def.planId, def.signupGrant);
    }
  }

  if (grantByPlan.size === 0) {
    console.info('[migration] backfill-signup-grant: no plan defines a signupGrant — nothing to do');
    return;
  }

  let granted = 0;
  let skipped = 0;

  const cursor = organizations.find(
    { plan: { $in: [...grantByPlan.keys()] } },
    { projection: { _id: 1, plan: 1 } },
  );

  for await (const org of cursor) {
    const orgId = org._id?.toString();
    const amount = grantByPlan.get(org.plan);
    if (!orgId || !amount) { skipped += 1; continue; }

    const idempotencyKey = `${GRANT_SOURCE}-${orgId}`;

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
            amount,
            source: GRANT_SOURCE,
            refId: idempotencyKey,
            at: new Date(),
          },
        },
        $inc: { cachedBalance: amount },
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

  console.info(`[migration] backfill-signup-grant: complete — granted=${granted} skipped=${skipped}`);
}

/**
 * Reverse: intentional no-op.
 *
 * This migration shares the `signup_grant` refId scheme with the app's runtime
 * grant and the earlier 20260511 backfill, so signup_grant ledger entries cannot
 * be attributed to this migration specifically. A blanket $pull would revert
 * legitimately-earned grants too. Reverting is left to a manual, audited
 * operation if ever required.
 *
 * @returns {Promise<void>}
 */
export async function down() {
  console.warn('[migration] backfill-signup-grant DOWN: intentional no-op — signup_grant entries are not attributable to this migration; revert manually if required.');
}
