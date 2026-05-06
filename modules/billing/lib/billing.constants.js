/**
 * Module dependencies
 */
import config from '../../../config/index.js';

/**
 * Sentinel value written to stripeSessionId during extras checkout session creation.
 * Stripe forbids a session from self-referencing its own id at creation time, so this
 * placeholder is used in both session.metadata and payment_intent_data.metadata.
 * After checkout.session.completed fires, the real cs_* id is patched onto the
 * PaymentIntent metadata — but Stripe Charge metadata is a one-time snapshot copied
 * at charge creation, so charge.metadata.stripeSessionId may still carry this sentinel
 * on refunds. Treat it as "unresolved" and trigger the PI backfill path.
 */
export const SENTINEL_PENDING = '__pending__';

export const DEFAULT_METER_RUN_BASE = 1;
export const DEFAULT_CRON_JITTER_MAX_MS = 60_000;
export const DEFAULT_PLAN_CHANGE_PRESERVE_USAGE = true;
export const DEFAULT_ALERT_THRESHOLD_PERCENTS = [80, 100];
export const DEFAULT_EXTRAS_EXHAUSTED_EVENT = 'billing.extras_debit.exhausted';
export const DEFAULT_GRACE_PERIOD_DAYS = 7;
export const DEFAULT_DUNNING_THRESHOLD_DAYS = 14;

/**
 * @function getMeterRunBase
 * @description Resolve the configured base units charged when no costs are present.
 *              Evaluated lazily on each call so test overrides and runtime config
 *              changes are always reflected (avoids the stale module-scope const pattern).
 * @returns {number} Meter run base units.
 */
export const getMeterRunBase = () =>
  config?.billing?.meter?.runBase
  ?? config?.billing?.meter?.runBaseUnits
  ?? DEFAULT_METER_RUN_BASE;

/**
 * @function getMeterFallbackPlanId
 * @description Resolve the configured fallback plan used by meter attribution.
 * @returns {string|null} Fallback plan id, or null when no explicit fallback exists.
 */
export const getMeterFallbackPlanId = () =>
  config?.billing?.meter?.fallbackPlanId
  ?? config?.billing?.plans?.[0]
  ?? 'pro';

/**
 * @function getCronJitterMaxMs
 * @description Resolve the maximum startup jitter for billing cron scripts.
 * @returns {number} Jitter maximum in milliseconds.
 */
export const getCronJitterMaxMs = () =>
  config?.billing?.crons?.jitterMaxMs ?? DEFAULT_CRON_JITTER_MAX_MS;

/**
 * @function getPlanChangePreserveUsageDefault
 * @description Resolve the default preserveUsage behavior for plan-change rotations.
 * @returns {boolean} Whether plan-change rotation preserves usage by default.
 */
export const getPlanChangePreserveUsageDefault = () =>
  config?.billing?.planChange?.preserveUsageDefault ?? DEFAULT_PLAN_CHANGE_PRESERVE_USAGE;

/**
 * @function getAlertThresholdPercents
 * @description Resolve configured meter alert threshold percentages.
 * @returns {number[]} Sorted threshold percentages.
 */
export const getAlertThresholdPercents = () => {
  const raw = config?.billing?.alerts?.thresholdPercents ?? DEFAULT_ALERT_THRESHOLD_PERCENTS;
  // Guard against env-override delivering a string (e.g. DEVKIT_NODE_billing_alerts_thresholdPercents=80)
  const thresholds = Array.isArray(raw) ? raw : [raw].map(Number).filter(Number.isFinite);
  return thresholds
    .map(Number)
    .filter((threshold) => Number.isFinite(threshold) && threshold > 0)
    .sort((a, b) => b - a);
};

/**
 * @function getDollarsToUnitRatio
 * @description Resolve the configured conversion factor from dollar amounts to meter units.
 * Returns the raw config value when valid; falls back to 1000.
 * @returns {number} Dollar-to-unit ratio (e.g. 1000 means $1 = 1000 units).
 */
export const getDollarsToUnitRatio = () => {
  const ratio = Number(config?.billing?.meter?.dollarsToUnitRatio);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1000;
};

/**
 * @function getMaxUnitsPerOperation
 * @description Resolve the configured per-operation unit cap. Infinity means no cap.
 * Returns the raw config value when valid (positive finite or Infinity); falls back to Infinity.
 * @returns {number} Maximum units allowed for a single attribute call.
 */
export const getMaxUnitsPerOperation = () => {
  const raw = config?.billing?.meter?.maxUnitsPerOperation;
  if (raw === undefined || raw === null) return Infinity;
  const cap = Number(raw);
  return Number.isFinite(cap) && cap > 0 ? cap : Infinity;
};

/**
 * @function getDefaultPlanId
 * @description Resolve the default plan ID used as a fallback when no active subscription exists.
 * Returns the raw config value when non-empty string; falls back to 'free'.
 * @returns {string} Default plan identifier.
 */
export const getDefaultPlanId = () => {
  const planId = config?.billing?.defaultPlan;
  return typeof planId === 'string' && planId.trim() ? planId : 'free';
};

/**
 * @function getExtrasExhaustedEventName
 * @description Resolve the event name emitted when extras debit retries are exhausted.
 * @returns {string} Billing extras exhausted event name.
 */
export const getExtrasExhaustedEventName = () =>
  config?.billing?.events?.extrasExhausted ?? DEFAULT_EXTRAS_EXHAUSTED_EVENT;

/**
 * @function getGracePeriodDays
 * @description Resolve the past_due grace period in days. Align with Stripe Dashboard → Smart retries.
 *              Falls back to DEFAULT_GRACE_PERIOD_DAYS when config is absent or not a positive integer.
 * @returns {number} Grace period in days.
 */
export const getGracePeriodDays = () => {
  const raw = Number(config?.billing?.gracePeriodDays);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_GRACE_PERIOD_DAYS;
};

/**
 * @function getDunningThresholdDays
 * @description Resolve the dunning threshold in days after which subscriptions are downgraded to free.
 *              Align with Stripe Dashboard → Smart retries → Final retry.
 *              Falls back to DEFAULT_DUNNING_THRESHOLD_DAYS when config is absent or not a positive integer.
 * @returns {number} Dunning threshold in days.
 */
export const getDunningThresholdDays = () => {
  const raw = Number(config?.billing?.dunningThresholdDays);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_DUNNING_THRESHOLD_DAYS;
};
