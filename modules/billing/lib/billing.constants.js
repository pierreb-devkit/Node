/**
 * Module dependencies
 */
import config from '../../../config/index.js';

export const DEFAULT_METER_RUN_BASE = 1;
export const DEFAULT_OUTBOX_MAX_RETRY_ATTEMPTS = 5;
export const DEFAULT_OUTBOX_RETRY_INTERVAL_SEC = 300;
export const DEFAULT_CRON_JITTER_MAX_MS = 60_000;
export const DEFAULT_PLAN_CHANGE_PRESERVE_USAGE = true;
export const DEFAULT_ALERT_THRESHOLD_PERCENTS = [80, 100];
export const DEFAULT_EXTRAS_EXHAUSTED_EVENT = 'billing.extras_debit.exhausted';

/**
 * Floor charge per run. `runBaseUnits` is kept as a backward-compatible alias
 * for downstream projects that already adopted the earlier config name.
 */
export const METER_RUN_BASE =
  config?.billing?.meter?.runBase
  ?? config?.billing?.meter?.runBaseUnits
  ?? DEFAULT_METER_RUN_BASE;

/**
 * @function getMeterRunBase
 * @description Resolve the configured base units charged when no costs are present.
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
 * @function getOutboxMaxRetryAttempts
 * @description Resolve the maximum number of retry attempts before an outbox row fails.
 * @returns {number} Maximum retry attempts.
 */
export const getOutboxMaxRetryAttempts = () =>
  config?.billing?.outbox?.maxRetryAttempts ?? DEFAULT_OUTBOX_MAX_RETRY_ATTEMPTS;

/**
 * @function getOutboxRetryIntervalMs
 * @description Resolve the outbox retry interval in milliseconds.
 * @returns {number} Retry interval in milliseconds.
 */
export const getOutboxRetryIntervalMs = () =>
  (config?.billing?.outbox?.retryIntervalSec ?? DEFAULT_OUTBOX_RETRY_INTERVAL_SEC) * 1000;

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
  const thresholds = config?.billing?.alerts?.thresholdPercents ?? DEFAULT_ALERT_THRESHOLD_PERCENTS;
  return thresholds
    .filter((threshold) => Number.isFinite(threshold) && threshold > 0)
    .sort((a, b) => b - a);
};

/**
 * @function getExtrasExhaustedEventName
 * @description Resolve the event name emitted when extras debit retries are exhausted.
 * @returns {string} Billing extras exhausted event name.
 */
export const getExtrasExhaustedEventName = () =>
  config?.billing?.events?.extrasExhausted ?? DEFAULT_EXTRAS_EXHAUSTED_EVENT;
