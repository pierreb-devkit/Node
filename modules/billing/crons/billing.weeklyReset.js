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
import { bootstrapCron } from '../lib/billing.cron-utils.js';

const {
  mongooseService,
  logger,
  applyJitter,
  getCronJitterMaxMs,
  acquireLock,
  releaseLock,
  LOCK_NAME,
  LOCK_TTL_MS,
} = await bootstrapCron({
  /**
   * Gate predicate for this cron — true when metered billing is enabled.
   * @param {object} config - Loaded app config.
   * @returns {boolean} True when config.billing.meterMode is truthy.
   */
  isEnabled: (config) => Boolean(config?.billing?.meterMode),
  gateMessage: '[cron.weeklyReset] meterMode disabled — skipping.',
  lockName: 'billing.weeklyReset',
  lockTtlMs: 10 * 60 * 1000, // 10 min
});

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
      // Log separately to preserve any original work error.
      try {
        await releaseLock({ name: LOCK_NAME, holder: lockHolder });
      } catch (releaseErr) {
        logger.error('[cron.weeklyReset] failed to release lock — will auto-expire on TTL', {
          err: releaseErr,
          cron: LOCK_NAME,
        });
      }
    }
  }
} catch (err) {
  logger.error('[cron.weeklyReset] failed', { err: err?.message, stack: err?.stack });
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
