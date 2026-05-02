/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import config from '../../../config/index.js';

const isPlainObject = (value) =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyRatios = (value) => isPlainObject(value) && Object.keys(value).length > 0;

const configuredPlans = () => {
  const byPlanId = new Map();

  const definitions = config?.billing?.planDefinitions;
  if (Array.isArray(definitions)) {
    for (const def of definitions) {
      if (def?.planId) byPlanId.set(def.planId, def);
    }
  }

  const legacyPlans = config?.billing?.plans;
  if (isPlainObject(legacyPlans)) {
    for (const [planId, def] of Object.entries(legacyPlans)) {
      byPlanId.set(planId, { ...(def ?? {}), planId });
    }
  }

  return byPlanId;
};

const canonicalSnapshot = (planId, plansById) => {
  const plan = plansById.get(planId);
  if (!plan) return null;

  const version = plan.version ?? config?.billing?.meter?.ratioVersion ?? null;
  if (!version || !isNonEmptyRatios(plan.ratios) || typeof plan.meterQuota !== 'number') {
    return null;
  }

  return {
    version,
    ratios: plan.ratios,
    meterQuota: plan.meterQuota,
  };
};

/**
 * Migration: Backfill BillingPlan version snapshots from billing config.
 *
 * Repairs legacy BillingPlan docs missing a version or frozen ratios by applying
 * the canonical configured snapshot for the same planId. Idempotent: documents
 * already at the canonical version with non-empty ratios are skipped.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const collection = mongoose.connection.db.collection('billingplans');
  const plansById = configuredPlans();
  const BATCH_SIZE = 500;
  let processed = 0;
  let skipped = 0;

  const cursor = collection.find(
    {
      $or: [
        { version: { $exists: false } },
        { version: null },
        { ratios: { $exists: false } },
        { ratios: null },
        { ratios: {} },
      ],
    },
    { projection: { _id: 1, planId: 1, version: 1, ratios: 1 } },
  );

  const ops = [];

  for await (const doc of cursor) {
    const canonical = canonicalSnapshot(doc.planId, plansById);
    if (!canonical) {
      console.warn(
        `[migration] backfill-plan-version-snapshots: missing canonical config for ${doc.planId}; skipping`,
      );
      skipped += 1;
      continue;
    }

    if (doc.version === canonical.version && isNonEmptyRatios(doc.ratios)) {
      skipped += 1;
      continue;
    }

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            version: canonical.version,
            ratios: canonical.ratios,
            meterQuota: canonical.meterQuota,
          },
        },
      },
    });

    if (ops.length >= BATCH_SIZE) {
      await collection.bulkWrite(ops, { ordered: false });
      processed += ops.length;
      ops.length = 0;
    }
  }

  if (ops.length > 0) {
    await collection.bulkWrite(ops, { ordered: false });
    processed += ops.length;
  }

  if (processed > 0 || skipped > 0) {
    console.info(
      `[migration] backfill-plan-version-snapshots: backfilled ${processed} documents, skipped ${skipped}`,
    );
  }
}

/**
 * Down: intentionally no-op.
 *
 * Reverting version snapshots can corrupt historical attribution because meter
 * calculations depend on immutable (planId, version) ratios. Keep consistency
 * and require manual intervention for any rollback.
 *
 * @returns {void}
 */
export function down() {
  console.warn(
    '[migration] backfill-plan-version-snapshots DOWN: no-op; preserving BillingPlan snapshots',
  );
}
