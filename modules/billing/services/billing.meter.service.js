/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import BillingPlanService from './billing.plan.service.js';

/**
 * Floor charge per run — configurable via config.billing.meter.runBaseUnits.
 * Guarantees every attributed event costs at least 1 unit regardless of costs.
 */
export const METER_RUN_BASE = config?.billing?.meter?.runBaseUnits ?? 1;

/**
 * @function unitsFromCosts
 * @description Convert a feature-keyed cost map (in USD) to meter units using
 *              a frozen plan ratio version. Ratios define how many units per
 *              dollar for each feature key.
 *
 *              Formula per key: floor(cost[key] * ratio[key] * dollarsToUnitRatio)
 *              Total: max(sum(per-key units), METER_RUN_BASE)
 *
 * @param {Object} costs - Feature-keyed cost map: { featureKey: usdCost }.
 * @param {string} planId - Logical plan identifier (e.g. "pro").
 * @param {string} ratioVersion - Specific plan version for the ratio lookup.
 * @returns {Promise<{totalUnits: number, breakdown: Object}>} Computed units and per-feature breakdown.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const unitsFromCosts = async (costs, planId, ratioVersion) => {
  if (!costs || typeof costs !== 'object') {
    return { totalUnits: METER_RUN_BASE, breakdown: {} };
  }

  const dollarsToUnitRatio = config?.billing?.meter?.dollarsToUnitRatio ?? 1000;

  // Fetch the frozen plan snapshot for the given version
  const plan = await BillingPlanService.getPlanByVersion(planId, ratioVersion);
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

  const totalUnits = Math.max(rawTotal, METER_RUN_BASE);

  return { totalUnits, breakdown };
};

/**
 * @function attribute
 * @description Attribute meter units from a History-like input to a Usage document
 *              for the given organization. If the plan quota is exceeded, falls back
 *              to BillingExtraService.debit. If extras are also exhausted, throws
 *              MeterQuotaExhausted.
 *
 *              Idempotent on history._id — a second call with the same history object
 *              is a no-op (replay protection via consumedHistoryIds).
 *
 * @param {Object} history - History-like object with _id, costs, planId, planVersion fields.
 * @param {string} organizationId - The organization ObjectId (string).
 * @returns {Promise<{applied: boolean, meterUsed: number, extrasConsumed: number}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const attribute = async (history, organizationId) => {
  if (!config?.billing?.meterMode) {
    return { applied: false, meterUsed: 0, extrasConsumed: 0 };
  }

  // Lazy imports to avoid circular deps — these services import billing.meter.service
  const { default: BillingUsageService } = await import('./billing.usage.service.js');
  const { default: BillingExtraService } = await import('./billing.extra.service.js');

  const planId = history.planId ?? config?.billing?.plans?.[0] ?? 'pro';
  const ratioVersion = history.planVersion ?? null;

  let totalUnits = METER_RUN_BASE;
  let breakdown = {};

  if (history.costs && ratioVersion) {
    ({ totalUnits, breakdown } = await unitsFromCosts(history.costs, planId, ratioVersion));
  }

  const idempotencyKey = history._id?.toString?.() ?? String(history._id);

  const result = await BillingUsageService.incrementMeter(
    organizationId,
    totalUnits,
    breakdown,
    idempotencyKey,
  );

  if (!result.applied) {
    // Replay — already attributed
    return { applied: false, meterUsed: result.meterUsed ?? 0, extrasConsumed: 0 };
  }

  let extrasConsumed = 0;
  if (result.extrasConsumed > 0) {
    extrasConsumed = result.extrasConsumed;
    await BillingExtraService.debit(organizationId, extrasConsumed, idempotencyKey);
  }

  return { applied: true, meterUsed: result.meterUsed, extrasConsumed };
};

export default {
  unitsFromCosts,
  attribute,
  METER_RUN_BASE,
};
