/**
 * Cron script — weekly Stripe↔DB reconciliation sweep.
 *
 * Runs on Sunday at 03:00 UTC. Paginates active|past_due subscriptions, fetches the
 * live Stripe status for each, and alerts on any status/plan divergence.
 *
 * Policy: LOG-ONLY — no auto-fix. Auto-fix is intentionally prohibited because it would
 * mask bugs silently. Ops must investigate divergences and use the admin sync endpoint
 * or admin cancel endpoint to resolve them.
 *
 * Intended to run as a Kubernetes CronJob (schedule: "0 3 * * 0").
 * See infra repo for the manifest — same pattern as billing.weeklyReset.
 *
 * Usage:
 *   NODE_ENV=production node modules/billing/crons/billing.reconcile.js
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
  import('../../../lib/services/distributedLock.js'),
]);

if (!config?.billing?.meterMode) {
  logger.info('[cron.reconcile] meterMode disabled — skipping.');
  process.exit(0);
}

const LOCK_NAME = 'billing.reconcile';
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 min — reconcile paginates Stripe per subscription

const startMs = Date.now();
logger.info('[cron.reconcile] start');

let lockHolder = null;
try {
  await applyJitter(getCronJitterMaxMs());
  await mongooseService.loadModels();
  await mongooseService.connect();

  lockHolder = `${process.env.HOSTNAME ?? 'unknown'}:${randomUUID()}`;
  const acquired = await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder: lockHolder });
  if (!acquired) {
    logger.info('[cron.reconcile] lock held by another pod, skipping');
    process.exitCode = 0;
  } else {
    try {
      const { default: BillingReconcileService } = await import('../services/billing.reconcile.service.js');

      const result = await BillingReconcileService.runReconciliation();
      logger.info('[cron.reconcile] complete', { checked: result.checked, divergences: result.divergences, errors: result.errors, durationMs: Date.now() - startMs });
      process.exitCode = result.errors > 0 ? 1 : 0;
    } finally {
      // releaseLock failure is non-fatal: lock auto-expires on TTL.
      // Log separately to preserve any original work error.
      try {
        await releaseLock({ name: LOCK_NAME, holder: lockHolder });
      } catch (releaseErr) {
        logger.error('[cron.reconcile] failed to release lock — will auto-expire on TTL', {
          err: releaseErr,
          cron: LOCK_NAME,
        });
      }
    }
  }
} catch (err) {
  logger.error('[cron.reconcile] failed', { err: err?.message, stack: err?.stack });
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
