/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import BillingPlanService from './billing.plan.service.js';
import BillingUsageService from './billing.usage.service.js';
import {
  getMeterFallbackPlanId,
  getMeterRunBase,
  getDollarsToUnitRatio,
  getMaxUnitsPerOperation,
} from '../lib/billing.constants.js';

/**
 * @function unitsFromCosts
 * @description Convert a feature-keyed cost map (in USD) to meter units using
 *              a frozen plan ratio version. Ratios define how many units per
 *              dollar for each feature key.
 *
 *              Formula per key: floor(cost[key] * ratio[key] * dollarsToUnitRatio)
 *              Total: sum(per-key units). Empty or zero-only cost maps return 0.
 *              METER_RUN_BASE applies only when costs is null/undefined.
 *
 *              When meterMode is enabled and getPlanByVersion returns null
 *              (version mismatch), throws so attribution cannot silently bill with
 *              ratio=1. When meterMode is disabled, keeps the legacy ratio=1 fallback.
 *
 * @param {Object} costs - Feature-keyed cost map: { featureKey: usdCost }.
 * @param {string} planId - Logical plan identifier (e.g. "pro").
 * @param {string} ratioVersion - Specific plan version for the ratio lookup.
 * @returns {{totalUnits: number, breakdown: Object}} Computed units and per-feature breakdown.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const unitsFromCosts = (costs, planId, ratioVersion) => {
  if (costs == null || typeof costs !== 'object') {
    return { totalUnits: getMeterRunBase(), breakdown: {} };
  }

  const dollarsToUnitRatio = getDollarsToUnitRatio();

  const hasBillableCost = Object.values(costs).some(
    (cost) => typeof cost === 'number' && Number.isFinite(cost) && cost > 0,
  );
  if (!hasBillableCost) {
    return { totalUnits: 0, breakdown: {} };
  }

  if (!ratioVersion) {
    const message = '[billing.meter] non-null costs without ratioVersion in meterMode';
    if (config?.billing?.meterMode) {
      throw new Error(message);
    }
    console.warn(message);
  }

  // Fetch the frozen plan snapshot for the given version (config-static, no await needed)
  const plan = ratioVersion ? BillingPlanService.getPlanByVersion(planId, ratioVersion) : null;
  if (!plan) {
    if (config?.billing?.meterMode && ratioVersion) {
      throw new Error(`[billing.meter] missing plan version snapshot for (${planId}, ${ratioVersion})`);
    }

    // WARN: version mismatch likely — costs.config emits a version that has no matching plan definition.
    if (ratioVersion) {
      // Charges will use ratio=1 (flat) for all features. Align meter.ratioVersion + planDefinitions[].version
      // + downstream cost-config emitted version to resolve. See billing README — Version Namespace Contract.
      console.warn(
        `[billing.meter] getPlanByVersion(${planId}, ${ratioVersion}) returned null — ratio=1 fallback applied. Check version namespace alignment.`,
      );
    }
  }
  const ratios = (plan && typeof plan.ratios === 'object' && !Array.isArray(plan.ratios)) ? plan.ratios : {};

  const breakdown = {};
  let rawTotal = 0;

  for (const [key, cost] of Object.entries(costs)) {
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) continue;

    const ratio = typeof ratios[key] === 'number' && ratios[key] >= 0 ? ratios[key] : 1;
    const units = Math.floor(cost * ratio * dollarsToUnitRatio);

    if (units > 0) {
      breakdown[key] = units;
      rawTotal += units;
    }
  }

  return { totalUnits: rawTotal, breakdown };
};

/**
 * @function capBreakdown
 * @description Rescale a feature breakdown map proportionally so its summed units do not exceed
 *              the capped total. Each bucket is scaled by (cappedUnits / originalTotal) and
 *              floored; any remainder is distributed to the largest remaining buckets so that
 *              sum(result) === cappedUnits exactly.
 * @param {Object} breakdown - Feature-keyed units map.
 * @param {number} cappedUnits - Final capped total units to apply.
 * @param {number} originalTotal - Original uncapped total (used as the scaling denominator).
 * @returns {Object} Proportionally rescaled feature-keyed units map.
 */
const capBreakdown = (breakdown, cappedUnits, originalTotal) => {
  if (!breakdown || typeof breakdown !== 'object' || cappedUnits === Infinity) return breakdown;

  const entries = Object.entries(breakdown).filter(
    ([, value]) => Number.isFinite(value) && value > 0,
  );
  if (entries.length === 0 || originalTotal <= 0) return Object.create(null);

  const ratio = cappedUnits / originalTotal;
  const cappedBreakdown = Object.create(null);
  let allocated = 0;

  for (const [key, value] of entries) {
    const scaled = Math.floor(value * ratio);
    cappedBreakdown[key] = scaled;
    allocated += scaled;
  }

  // Distribute remainder (due to floor) to the largest buckets first
  let remainder = cappedUnits - allocated;
  if (remainder > 0) {
    const sorted = entries.slice().sort(([, a], [, b]) => b - a);
    for (const [key] of sorted) {
      if (remainder <= 0) break;
      cappedBreakdown[key] += 1;
      remainder -= 1;
    }
  }

  return cappedBreakdown;
};

/**
 * @function attribute
 * @description Attribute meter units from a History-like input to a Usage document
 *              for the given organization. Overflow into extras is handled atomically
 *              inline in BillingUsageService.incrementMeter — no outbox needed.
 *
 *              Per-step idempotency: the idempotency key is `${history._id}:${stepKey}`.
 *              This allows multiple attributions on the same history at different processing
 *              steps (e.g. 'initial', 'digest', 'fix:1') without silently blocking the
 *              cost delta for subsequent steps.
 *
 *              Each stepKey call is independently idempotent — replaying the same
 *              `(history._id, stepKey)` pair is a no-op (replay protection via consumedAttributionKeys).
 *
 *              IMPORTANT: each call must pass ONLY the cost delta for that step (not the
 *              cumulative total), otherwise earlier steps will be double-charged.
 *
 * @param {Object} history - History-like object with _id, costs, planId, planVersion fields.
 * @param {string} organizationId - The organization ObjectId (string).
 * @param {Object} [options={}] - Optional per-step configuration.
 * @param {string|null|undefined} [options.stepKey='initial'] - Logical step name scoping this attribution.
 * @param {Object|null|undefined} [options.costsOverride=null] - Optional cost map to charge
 *   instead of history.costs.
 * @param {Object|null|undefined} [options.costs=null] - Alias cost map used when
 *   options.costsOverride is not provided.
 * @param {string|null|undefined} [options.planId=null] - Optional planId override.
 * @param {string|null|undefined} [options.ratioVersion=null] - Optional ratio snapshot override.
 * @returns {Promise<{applied: boolean, meterUsed: number, extrasConsumed: number, reason?: string}>}
 * @throws {Error} If stepKey is non-null/undefined and does not match the expected format.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const attribute = async (history, organizationId, options = {}) => {
  // Fast-path: when metering is disabled, skip all validation and return immediately.
  if (!config?.billing?.meterMode) {
    return { applied: false, meterUsed: 0, extrasConsumed: 0 };
  }

  const {
    stepKey = 'initial',
    costs: explicitCosts = null,
    costsOverride = null,
    planId: explicitPlanId = null,
    ratioVersion: explicitRatioVersion = null,
  } = options ?? {};

  // Validate stepKey: must be a non-empty alphanumeric+colon+hyphen+underscore string (1-64 chars).
  // null/undefined → treated as absent → defaults to 'initial' (safe, intentional).
  // Any other non-conforming value → throws so callers can detect and fix bad inputs.
  if (
    stepKey != null &&
    (typeof stepKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,64}$/.test(stepKey))
  ) {
    throw new Error(`[billing.meter] invalid stepKey: ${JSON.stringify(stepKey)}`);
  }
  const validatedStepKey = stepKey ?? 'initial';

  const idempotencyKey = `${history._id?.toString?.() ?? String(history._id)}:${validatedStepKey}`;
  const planId = explicitPlanId ?? history.planId ?? getMeterFallbackPlanId();
  const ratioVersion = explicitRatioVersion ?? history.planVersion ?? null;
  const costs = costsOverride ?? explicitCosts ?? history.costs;

  let totalUnits = getMeterRunBase();
  let breakdown = {};

  if (costs != null) {
    ({ totalUnits, breakdown } = unitsFromCosts(costs, planId, ratioVersion));
  }

  const maxUnits = getMaxUnitsPerOperation();
  const cappedUnits = Math.min(totalUnits, maxUnits);
  const isCapped = cappedUnits < totalUnits;
  const cappedBreakdown = isCapped ? capBreakdown(breakdown, cappedUnits, totalUnits) : breakdown;
  if (isCapped) {
    console.warn(
      `[billing.meter] units capped: requested ${totalUnits}, cap ${maxUnits}, applied ${cappedUnits}`,
    );
  }

  if (cappedUnits === 0) {
    await BillingUsageService.incrementMeter(organizationId, 0, {}, idempotencyKey);
    return { applied: false, meterUsed: 0, extrasConsumed: 0, reason: 'zero_cost_skipped' };
  }

  const result = await BillingUsageService.incrementMeter(
    organizationId,
    cappedUnits,
    cappedBreakdown,
    idempotencyKey,
  );

  if (!result.applied) {
    // Replay — already attributed
    return { applied: false, meterUsed: result.meterUsed ?? 0, extrasConsumed: 0 };
  }

  return { applied: true, meterUsed: result.meterUsed, extrasConsumed: result.extrasConsumed };
};

export default {
  unitsFromCosts,
  attribute,
  capBreakdown,
  getMeterRunBase,
};
