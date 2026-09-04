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
 * @description Shared bootstrap preamble for billing cron scripts: validates params, loads the standard cron dependencies in parallel, then applies the cron's config gate.
 * @param {object} params
 * @param {(config: object) => boolean} params.isEnabled - Gate predicate; receives the
 *   loaded config and returns true when the cron should proceed. Required — must be a
 *   function, checked before any dynamic import runs.
 * @param {string} params.gateMessage - Logged (via `logger.info`) when the gate is
 *   closed, immediately before the process exits with code 0. Required — every cron
 *   has something to say when it's skipped, so this is validated like the rest rather
 *   than left to log `undefined` silently.
 * @param {string} params.lockName - Distributed lock name for this cron, echoed back
 *   as `LOCK_NAME`. Required non-empty string — an empty/missing name would still let
 *   `acquireLock` return `true` for every caller (no real mutual exclusion), so this is
 *   validated here rather than relying on a downstream check in a different module.
 * @param {number} params.lockTtlMs - Distributed lock TTL in ms for this cron, echoed
 *   back as `LOCK_TTL_MS`. Required positive finite number.
 * @throws {Error} Rejects before any dynamic import or other side effect runs, if
 *   `isEnabled` is not a function, `gateMessage`/`lockName` is not a non-empty string,
 *   or `lockTtlMs` is not a positive finite number. A cron that cannot lock must not
 *   run — failing loudly at startup beats a cron that looks healthy but never locks
 *   anything.
 * @returns {Promise<object|null>} `{ config, mongooseService, logger, applyJitter,
 *   acquireLock, releaseLock, LOCK_NAME, LOCK_TTL_MS, ...billingConstants }` when the
 *   gate is open, else `null` (the closed-gate path calls `process.exit(0)` first, so
 *   this return is unreachable in a real run — it only matters to a test that mocks
 *   `process.exit`).
 */
export const bootstrapCron = async ({ isEnabled, gateMessage, lockName, lockTtlMs }) => {
  if (typeof isEnabled !== 'function') {
    throw new Error(`bootstrapCron: isEnabled must be a function, received ${typeof isEnabled}`);
  }
  if (typeof gateMessage !== 'string' || gateMessage.length === 0) {
    throw new Error(`bootstrapCron: gateMessage must be a non-empty string, received ${JSON.stringify(gateMessage)}`);
  }
  if (typeof lockName !== 'string' || lockName.length === 0) {
    throw new Error(`bootstrapCron: lockName must be a non-empty string, received ${JSON.stringify(lockName)}`);
  }
  if (!Number.isFinite(lockTtlMs) || lockTtlMs <= 0) {
    // String(), not JSON.stringify() — JSON.stringify(Infinity/NaN) both collapse to
    // the string "null", which would misreport exactly the values this guards against.
    throw new Error(`bootstrapCron: lockTtlMs must be a positive finite number, received ${String(lockTtlMs)}`);
  }

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
