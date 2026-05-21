/**
 * Cron script — dunning sweep.
 *
 * Finds subscriptions in 'past_due' status whose pastDueSince is older than the
 * configured dunning threshold (config.billing.dunningThresholdDays, default 14 days —
 * i.e. grace period + blocked period elapsed with no payment), transitions them to
 * 'unpaid' + plan 'free', and syncs the Organization.plan field accordingly.
 *
 * Default timeline: payment fails → pastDueSince set → 7d grace (degraded mode) →
 * 7d blocked (402) → this cron fires on day 14+ and downgrades to free.
 * Both grace and dunning thresholds are configurable in billing config.
 *
 * No-op when config.billing.meterMode === false (default).
 * Intended to run as a Kubernetes CronJob — see modules/billing/crons/README.md.
 *
 * Usage:
 *   NODE_ENV=production node modules/billing/crons/billing.dunningSweep.js
 */

import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const [
  { default: config },
  { default: mongooseService },
  { default: logger },
  { applyJitter },
  { getCronJitterMaxMs, getDunningThresholdDays },
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
  logger.info('[cron.dunningSweep] meterMode disabled — skipping.');
  process.exit(0);
}

const LOCK_NAME = 'billing.dunningSweep';
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 min

const startMs = Date.now();
logger.info('[cron.dunningSweep] start');

let lockHolder = null;
try {
  await applyJitter(getCronJitterMaxMs());
  await mongooseService.connect();

  lockHolder = `${process.env.HOSTNAME ?? 'unknown'}:${randomUUID()}`;
  const acquired = await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder: lockHolder });
  if (!acquired) {
    logger.info('[cron.dunningSweep] lock held by another pod, skipping');
    process.exitCode = 0;
  } else {
    try {
      const [{ default: BillingSubscriptionRepository }, { default: OrganizationRepository }] = await Promise.all([
        import('../repositories/billing.subscription.repository.js'),
        import('../../organizations/repositories/organizations.repository.js'),
      ]);

      const now = new Date();
      const threshold = new Date(now.getTime() - getDunningThresholdDays() * 24 * 60 * 60 * 1000);

      const staleSubs = await BillingSubscriptionRepository.findStaleDunning(threshold);
      logger.info('[cron.dunningSweep] stale past_due subscriptions found', { count: staleSubs.length });

      let processed = 0;
      let errors = 0;
      let desyncErrors = 0;

      for (const sub of staleSubs) {
        try {
          const subscription = await BillingSubscriptionRepository.markUnpaid(String(sub._id), threshold);
          if (!subscription) {
            logger.info('[cron.dunningSweep] sub skipped — already recovered', { subId: String(sub._id) });
            continue;
          }

          try {
            await OrganizationRepository.setPlan(String(sub.organization), 'free');
          } catch (orgErr) {
            // Compensation: Subscription is now unpaid but Org.plan update failed.
            // Log for manual reconciliation — do not revert Subscription status.
            logger.error('[cron.dunningSweep] Org plan sync failed (manual reconciliation required)', {
              subId: String(sub._id),
              orgId: String(sub.organization),
              err: orgErr?.message,
              stack: orgErr?.stack,
            });
            desyncErrors += 1;
          }

          logger.info('[cron.dunningSweep] sub transitioned to unpaid', {
            subId: String(sub._id),
            orgId: String(sub.organization),
          });
          processed += 1;
        } catch (err) {
          errors += 1;
          logger.error('[cron.dunningSweep] failed for sub', { subId: String(sub._id), err: err?.message, stack: err?.stack });
        }
      }

      logger.info('[cron.dunningSweep] complete', { processed, errors, desyncErrors, durationMs: Date.now() - startMs });
      process.exitCode = errors > 0 || desyncErrors > 0 ? 1 : 0;
    } finally {
      // releaseLock failure is non-fatal: lock auto-expires on TTL.
      // Log separately to preserve any original work error.
      try {
        await releaseLock({ name: LOCK_NAME, holder: lockHolder });
      } catch (releaseErr) {
        logger.error(
          { err: releaseErr, cron: LOCK_NAME },
          '[cron.dunningSweep] failed to release lock — will auto-expire on TTL',
        );
      }
    }
  }
} catch (err) {
  logger.error('[cron.dunningSweep] failed', { err: err?.message, stack: err?.stack });
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
