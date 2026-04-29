/**
 * Module dependencies
 */
import mongoose from 'mongoose';

/**
 * In-memory cache: planId → { plan, fetchedAt }
 * Short TTL to reduce stale-read window across restarts / deploys.
 * Only non-null plans are cached — null (plan not found) is never cached
 * so that a newly-created plan is visible on the next read without waiting.
 */
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve the BillingPlan model lazily so the service can be imported before
 * Mongoose models are registered (unit-test friendliness).
 * @returns {import('mongoose').Model} BillingPlan Mongoose model
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const BillingPlan = () => mongoose.model('BillingPlan');

/**
 * @desc Get the currently active plan for a given planId.
 *       Results are cached in-memory for CACHE_TTL to avoid hot-path DB reads.
 * @param {string} planId - The logical plan identifier (e.g. "pro").
 * @returns {Promise<Object|null>} The active BillingPlan document, or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getActivePlan = async (planId) => {
  const cached = cache.get(planId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.plan;

  const plan = await BillingPlan().findOne({ planId, active: true, effectiveUntil: null }).lean();
  // Only cache non-null results — a null miss should not be cached so that a
  // newly-created plan is visible on the next read without waiting for TTL expiry.
  if (plan !== null) cache.set(planId, { plan, fetchedAt: Date.now() });
  return plan;
};

/**
 * @desc Get an immutable plan snapshot by (planId, version).
 *       Useful for replay / attribution on historical records.
 * @param {string} planId - The logical plan identifier.
 * @param {string} version - The specific version string.
 * @returns {Promise<Object|null>} The BillingPlan document, or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getPlanByVersion = async (planId, version) => {
  return BillingPlan().findOne({ planId, version }).lean();
};

/**
 * @desc Create a new plan version, deactivating the previous active version.
 *
 * Design: avoids Mongo sessions/transactions to remain compatible with
 * standalone MongoDB (no replica set required — mirrors the pattern used in
 * organizations.membership.service.js). The deactivation is a best-effort
 * updateMany; the unique (planId, version) index guards against duplicate
 * versions on concurrent bumps. If a duplicate-key error is thrown, the caller
 * should retry.
 *
 * @param {string} planId - The logical plan identifier.
 * @param {Object} fields - New plan fields.
 * @param {number} fields.computeQuota - New compute quota.
 * @param {Object} [fields.ratios] - New ratio map.
 * @param {string} [fields.stripePriceMonthly] - New Stripe monthly price ID.
 * @param {string} [fields.stripePriceAnnual] - New Stripe annual price ID.
 * @returns {Promise<Object>} The newly created BillingPlan document.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const bumpVersion = async (planId, fields) => {
  const Model = BillingPlan();
  const now = new Date();

  // Deactivate all currently active versions for this planId
  await Model.updateMany(
    { planId, active: true },
    { $set: { active: false, effectiveUntil: now } },
  );

  // Determine next sequential version number
  const count = await Model.countDocuments({ planId });
  const version = `v${count + 1}`;

  const created = await Model.create({
    planId,
    version,
    computeQuota: fields.computeQuota,
    ratios: fields.ratios ?? {},
    stripePriceMonthly: fields.stripePriceMonthly ?? null,
    stripePriceAnnual: fields.stripePriceAnnual ?? null,
    effectiveFrom: now,
    effectiveUntil: null,
    active: true,
  });

  const newPlan = Array.isArray(created) ? created[0] : created;

  // Evict cache so next read fetches the new version
  cache.delete(planId);

  return newPlan;
};

/**
 * @desc Manually invalidate the in-memory cache for a given planId.
 *       Useful after external plan mutations (e.g., admin tooling, tests).
 * @param {string} planId - The logical plan identifier to evict.
 * @returns {void}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const invalidateCache = (planId) => {
  cache.delete(planId);
};

export default {
  getActivePlan,
  getPlanByVersion,
  bumpVersion,
  invalidateCache,
};
