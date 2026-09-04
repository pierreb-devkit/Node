/**
 * Module dependencies
 */
import { randomInt } from 'node:crypto';

/**
 * @function applyJitter
 * @description Sleep for a random number of milliseconds from 0 to maxMs.
 * @param {number} maxMs - Exclusive upper bound for jitter in milliseconds.
 * @returns {Promise<number>} The number of milliseconds slept.
 */
export const applyJitter = async (maxMs) => {
  if (!Number.isFinite(maxMs) || maxMs <= 0) return 0;
  const jitterMaxMs = Math.floor(maxMs);
  if (jitterMaxMs <= 0) return 0; // guard fractional inputs (e.g. 0.4) — randomInt(0,0) throws
  const delayMs = randomInt(0, jitterMaxMs);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return delayMs;
};

/**
 * @function bootstrapCron
 * @description Shared bootstrap preamble for billing cron scripts: sets the NODE_ENV
 *              default, loads the standard cron dependencies (config, mongooseService,
 *              logger, distributedLock, and every named export of billing.constants.js)
 *              in parallel, then applies the cron's config gate. The gate predicate and
 *              message are parameters — not uniform across crons (referralReconcile
 *              gates on `billing.referral.enabled`, the rest on `billing.meterMode`).
 *              Constants are spread wholesale (not just `getCronJitterMaxMs`) so a
 *              cron needing a different one (e.g. `getDunningThresholdDays`) still gets
 *              it without this function enumerating every call site. `lockName`/
 *              `lockTtlMs` are echoed back as `LOCK_NAME`/`LOCK_TTL_MS` so the per-cron
 *              lock literals live at the call site next to the values they describe.
 * @param {object} params
 * @param {(config: object) => boolean} params.isEnabled - Gate predicate; receives the
 *   loaded config and returns true when the cron should proceed.
 * @param {string} params.gateMessage - Logged (via `logger.info`) when the gate is
 *   closed, immediately before the process exits with code 0.
 * @param {string} params.lockName - Distributed lock name for this cron, echoed back
 *   as `LOCK_NAME`.
 * @param {number} params.lockTtlMs - Distributed lock TTL in ms for this cron, echoed
 *   back as `LOCK_TTL_MS`.
 * @returns {Promise<object|null>} `{ config, mongooseService, logger, applyJitter,
 *   acquireLock, releaseLock, LOCK_NAME, LOCK_TTL_MS, ...billingConstants }` when the
 *   gate is open, else `null` (the closed-gate path calls `process.exit(0)` first, so
 *   this return is unreachable in a real run — it only matters to a test that mocks
 *   `process.exit`).
 */
export const bootstrapCron = async ({ isEnabled, gateMessage, lockName, lockTtlMs }) => {
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';

  const [
    { default: config },
    { default: mongooseService },
    { default: logger },
    constants,
    { acquireLock, releaseLock },
  ] = await Promise.all([
    import('../../../config/index.js'),
    import('../../../lib/services/mongoose.js'),
    import('../../../lib/services/logger.js'),
    import('./billing.constants.js'),
    import('../../../lib/services/distributedLock.js'),
  ]);

  if (!isEnabled(config)) {
    logger.info(gateMessage);
    process.exit(0);
    return null;
  }

  return {
    ...constants,
    config,
    mongooseService,
    logger,
    applyJitter,
    acquireLock,
    releaseLock,
    LOCK_NAME: lockName,
    LOCK_TTL_MS: lockTtlMs,
  };
};

export default {
  applyJitter,
  bootstrapCron,
};
