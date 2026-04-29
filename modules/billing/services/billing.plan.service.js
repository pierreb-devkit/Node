/**
 * Module dependencies
 */
import mongoose from 'mongoose';

/**
 * In-memory cache: planId → { plan, fetchedAt }
 */
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Resolve the BillingPlan model lazily so the service can be imported before
 * Mongoose models are registered (unit-test friendliness).
 * @returns {import('mongoose').Model} BillingPlan Mongoose model
 */
const BillingPlan = () => mongoose.model('BillingPlan');

/**
 * @desc Get the currently active plan for a given planId.
 *       Results are cached in-memory for CACHE_TTL to avoid hot-path DB reads.
 * @param {string} planId - The logical plan identifier (e.g. "pro").
 * @returns {Promise<Object|null>} The active BillingPlan document, or null.
 */
const getActivePlan = async (planId) => {
  const cached = cache.get(planId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.plan;

  const plan = await BillingPlan().findOne({ planId, active: true, effectiveUntil: null }).lean();
  cache.set(planId, { plan, fetchedAt: Date.now() });
  return plan;
};

/**
 * @desc Get an immutable plan snapshot by (planId, version).
 *       Useful for replay / attribution on historical records.
 * @param {string} planId - The logical plan identifier.
 * @param {string} version - The specific version string.
 * @returns {Promise<Object|null>} The BillingPlan document, or null.
 */
const getPlanByVersion = async (planId, version) => {
  return BillingPlan().findOne({ planId, version }).lean();
};

/**
 * @desc Create a new plan version, atomically deactivating the previous one.
 *
 * Design: uses a Mongo session + transaction so the deactivation of the old
 * version and the insertion of the new version are atomic. Callers on
 * standalone Mongo (no replica set) will get an error — document the
 * requirement in deployment notes.
 *
 * @param {string} planId - The logical plan identifier.
 * @param {Object} fields - New plan fields.
 * @param {number} fields.computeQuota - New compute quota.
 * @param {Object} [fields.ratios] - New ratio map.
 * @param {string} [fields.stripePriceMonthly] - New Stripe monthly price ID.
 * @param {string} [fields.stripePriceAnnual] - New Stripe annual price ID.
 * @returns {Promise<Object>} The newly created BillingPlan document.
 */
const bumpVersion = async (planId, fields) => {
  const Model = BillingPlan();
  const session = await mongoose.startSession();

  try {
    let newPlan;

    await session.withTransaction(async () => {
      const now = new Date();

      // Deactivate all currently active versions
      await Model.updateMany(
        { planId, active: true },
        { $set: { active: false, effectiveUntil: now } },
        { session },
      );

      // Determine next sequential version number
      const count = await Model.countDocuments({ planId }, { session });
      const version = `v${count + 1}`;

      newPlan = await Model.create(
        [
          {
            planId,
            version,
            computeQuota: fields.computeQuota,
            ratios: fields.ratios ?? {},
            stripePriceMonthly: fields.stripePriceMonthly ?? null,
            stripePriceAnnual: fields.stripePriceAnnual ?? null,
            effectiveFrom: now,
            effectiveUntil: null,
            active: true,
          },
        ],
        { session },
      );

      newPlan = Array.isArray(newPlan) ? newPlan[0] : newPlan;
    });

    // Evict cache so next read fetches the new version
    cache.delete(planId);

    return newPlan;
  } finally {
    await session.endSession();
  }
};

/**
 * @desc Manually invalidate the in-memory cache for a given planId.
 *       Useful after external plan mutations (e.g., admin tooling, tests).
 * @param {string} planId - The logical plan identifier to evict.
 * @returns {void}
 */
const invalidateCache = (planId) => {
  cache.delete(planId);
};

export default {
  getActivePlan,
  getPlanByVersion,
  bumpVersion,
  invalidateCache,
};
