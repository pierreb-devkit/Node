/**
 * Cron script — weekly meter reset sweep.
 *
 * Iterates active subscriptions and resets the meter for each org whose
 * billing period rolled over within the last 7 days.
 *
 * No-op when config.billing.meterMode === false (default).
 * Intended to run as a Kubernetes CronJob — see modules/billing/crons/README.md.
 *
 * Usage:
 *   NODE_ENV=production node modules/billing/crons/billing.weeklyReset.js
 */

import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const [
  { default: config },
  { default: mongooseService },
  { default: logger },
  { applyJitter },
  { getCronJitterMaxMs },
  { acquireLock, releaseLock },
] = await Promise.all([
  import('../../../config/index.js'),
  import('../../../lib/services/mongoose.js'),
  import('../../../lib/services/logger.js'),
  import('../lib/billing.cron-utils.js'),
  import('../lib/billing.constants.js'),
  import('../../../lib/distributedLock.js'),
]);

if (!config?.billing?.meterMode) {
  logger.info('[cron.weeklyReset] meterMode disabled — skipping.');
  process.exit(0);
}

const LOCK_NAME = 'billing.weeklyReset';
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 min

const startMs = Date.now();
logger.info('[cron.weeklyReset] start');

let lockHolder = null;
try {
  await applyJitter(getCronJitterMaxMs());
  await mongooseService.loadModels();
  await mongooseService.connect();

  lockHolder = `${process.env.HOSTNAME ?? 'unknown'}:${randomUUID()}`;
  const acquired = await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder: lockHolder });
  if (!acquired) {
    logger.info('[cron.weeklyReset] lock held by another pod, skipping');
    process.exitCode = 0;
  } else {
    try {
      const { default: BillingResetService } = await import('../services/billing.reset.service.js');

      const result = await BillingResetService.resetAllDue();
      logger.info('[cron.weeklyReset] complete', { processed: result.processed, errors: result.errors, durationMs: Date.now() - startMs });
      process.exitCode = result.errors > 0 ? 1 : 0;
    } finally {
      // releaseLock failure is non-fatal: lock auto-expires on TTL.
      // If this throws, the outer catch logs "failed" and sets exitCode=1
      // (misleading — the cron's actual work succeeded). Operators can grep
      // for "failed to release lock" to distinguish.
      await releaseLock({ name: LOCK_NAME, holder: lockHolder });
    }
  }
} catch (err) {
  logger.error('[cron.weeklyReset] failed', { err: err?.message, stack: err?.stack });
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
