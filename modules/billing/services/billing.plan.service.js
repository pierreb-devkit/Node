/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import BillingPlanRepository from '../repositories/billing.plan.repository.js';

/**
 * In-memory cache: planId → { plan, fetchedAt }
 *
 * Multi-pod stale window: each pod has its own cache; after bumpVersion
 * in pod A, pod B serves stale plan for up to CACHE_TTL. Acceptable in
 * V1 (admin-rare path). Future: emit billingEvents.emit('plan.versionBumped',
 * { planId }) and have each pod subscribe + invalidateCache locally.
 * Tracked in pierreb-devkit/Node#3533 PR-N3 (webhook layer).
 *
 * Short TTL to reduce stale-read window across restarts / deploys.
 * Only non-null plans are cached — null (plan not found) is never cached
 * so that a newly-created plan is visible on the next read without waiting.
 */
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * @desc Get the currently active plan for a given planId.
 *       Results are cached in-memory for CACHE_TTL to avoid hot-path DB reads.
 *
 * Returns null when no active plan is seeded for the given planId.
 * This is normal at first boot or when a new planId is added to
 * config.billing.plans without a corresponding BillingPlan.create()
 * (or a seeding migration). Callers should treat null as a hard error
 * when meterMode is enabled — typically by returning 503 from middleware
 * with a clear "plan not configured" payload.
 *
 * @param {string} planId - The logical plan identifier (e.g. "pro").
 * @returns {Promise<Object|null>} The active BillingPlan document, or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getActivePlan = async (planId) => {
  const cached = cache.get(planId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.plan;

  const plan = await BillingPlanRepository.findActive(planId);
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
  return BillingPlanRepository.findByVersion(planId, version);
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
 * Concurrent calls : two simultaneous bumpVersion('pro', ...) calls can race
 * on countDocuments → both derive version="vN+1" → unique index makes one
 * win, the other throws `E11000 duplicate key`. Caller MUST retry on E11000
 * with exponential backoff (e.g. 100ms / 300ms / 900ms, max 3 attempts).
 *
 * Activation gap : between deactivateAll() and create(), a brief window
 * exists where no plan is active. getActivePlan() called concurrently
 * during this window returns null. Callers must handle null gracefully.
 *
 * @param {string} planId - The logical plan identifier.
 * @param {Object} fields - New plan fields.
 * @param {number} fields.meterQuota - New meter quota.
 * @param {Object} [fields.ratios] - New ratio map.
 * @param {string} [fields.stripePriceMonthly] - New Stripe monthly price ID.
 * @param {string} [fields.stripePriceAnnual] - New Stripe annual price ID.
 * @returns {Promise<Object>} The newly created BillingPlan document.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const bumpVersion = async (planId, fields) => {
  const now = new Date();

  // Deactivate all currently active versions for this planId
  await BillingPlanRepository.deactivateAll(planId, now);

  // Determine next sequential version number
  const total = await BillingPlanRepository.count(planId);
  const version = `v${total + 1}`;

  const created = await BillingPlanRepository.create({
    planId,
    version,
    meterQuota: fields.meterQuota,
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

/**
 * @desc Wrap bumpVersion with exponential backoff retry on E11000 duplicate key errors.
 *       Two concurrent bumpVersion calls on the same planId can both derive the same
 *       version number before either insert lands — the unique (planId, version) index
 *       makes one winner and one loser (E11000). The loser retries with a fresh count.
 *
 * @param {string} planId - The logical plan identifier.
 * @param {Object} fields - New plan fields (same as bumpVersion).
 * @param {Object} [options={}] - Retry options.
 * @param {number} [options.maxAttempts=3] - Maximum number of attempts (including the first).
 * @returns {Promise<Object>} The newly created BillingPlan document.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const bumpVersionWithRetry = async (planId, fields, { maxAttempts = 3 } = {}) => {
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error('maxAttempts must be a positive integer');
  }
  const backoffMs = [100, 300, 900];
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await bumpVersion(planId, fields);
    } catch (err) {
      const isE11000 = err.code === 11000 || (err.message && err.message.includes('E11000'));
      if (!isE11000 || attempt === maxAttempts - 1) throw err;
      lastErr = err;
      const delay = backoffMs[attempt] ?? 900;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastErr;
};

/**
 * @function ensureSeeded
 * @description Upsert BillingPlan docs from config.billing.planDefinitions.
 *              For each configured planId, ensures an active plan exists.
 *              No-op when meter mode is disabled. Idempotent on re-run.
 *
 *              Race / E11000 safety: version is derived from the total count of
 *              existing docs for the planId (same strategy as bumpVersion). A
 *              try-catch on create absorbs E11000 from concurrent multi-pod
 *              startup races — the losing pod simply increments skipped.
 *
 * @returns {Promise<{seeded: number, skipped: number}>} Seed summary.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const ensureSeeded = async () => {
  if (!config?.billing?.meterMode) return { seeded: 0, skipped: 0 };

  const definitions = config?.billing?.planDefinitions ?? {};
  let seeded = 0;
  let skipped = 0;

  for (const [planId, def] of Object.entries(definitions)) {
    const existing = await BillingPlanRepository.findActive(planId);
    if (existing) {
      skipped += 1;
      continue;
    }

    try {
      // Derive version from total count so that an inactive v1 record does not
      // collide with the insert (same approach as bumpVersion to avoid hardcoding 'v1').
      const total = await BillingPlanRepository.count(planId);
      const version = `v${total + 1}`;

      await BillingPlanRepository.create({
        planId,
        version,
        meterQuota: def.meterQuota ?? 0,
        ratios: def.ratios ?? { default: 1 },
        effectiveFrom: new Date(),
        effectiveUntil: null,
        active: true,
      });
      cache.delete(planId);
      seeded += 1;
    } catch (err) {
      // E11000: concurrent pod beat us to the insert — treat as skip, not fatal.
      const isE11000 = err.code === 11000 || (err.message && err.message.includes('E11000'));
      if (isE11000) {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }

  return { seeded, skipped };
};

export default {
  getActivePlan,
  getPlanByVersion,
  bumpVersion,
  bumpVersionWithRetry,
  ensureSeeded,
  invalidateCache,
};
