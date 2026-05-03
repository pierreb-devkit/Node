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

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const [
  { default: config },
  { default: mongooseService },
  { applyJitter },
  { getCronJitterMaxMs, getDunningThresholdDays },
] = await Promise.all([
  import('../../../config/index.js'),
  import('../../../lib/services/mongoose.js'),
  import('../lib/billing.cron-utils.js'),
  import('../lib/billing.constants.js'),
]);

if (!config?.billing?.meterMode) {
  console.log('[billing.dunningSweep] meterMode disabled — skipping.');
  process.exit(0);
}

try {
  await applyJitter(getCronJitterMaxMs());
  await mongooseService.connect();

  const [{ default: BillingSubscriptionRepository }, { default: OrganizationRepository }] = await Promise.all([
    import('../repositories/billing.subscription.repository.js'),
    import('../../organizations/repositories/organizations.repository.js'),
  ]);

  const now = new Date();
  const threshold = new Date(now.getTime() - getDunningThresholdDays() * 24 * 60 * 60 * 1000);

  const staleSubs = await BillingSubscriptionRepository.findStaleDunning(threshold);
  console.log(`[billing.dunningSweep] ${staleSubs.length} stale past_due subscription(s) found`);

  let processed = 0;
  let errors = 0;
  let desyncErrors = 0;

  for (const sub of staleSubs) {
    try {
      const subscription = await BillingSubscriptionRepository.markUnpaid(String(sub._id));
      if (!subscription) continue; // markUnpaid returns null on invalid id

      try {
        await OrganizationRepository.setPlan(String(sub.organization), 'free');
      } catch (orgErr) {
        // Compensation: Subscription is now unpaid but Org.plan update failed.
        // Log for manual reconciliation — do not revert Subscription status.
        console.error('[billing.dunningSweep] Org plan sync failed (manual reconciliation required):', orgErr);
        desyncErrors += 1;
      }

      console.log(`[billing.dunningSweep] sub ${sub._id} → unpaid, org ${sub.organization} → free`);
      processed += 1;
    } catch (err) {
      errors += 1;
      console.error(`[billing.dunningSweep] failed for sub ${sub._id}:`, err);
    }
  }

  console.log(`[billing.dunningSweep] done — processed: ${processed}, errors: ${errors}, desyncErrors: ${desyncErrors}`);
  process.exitCode = errors > 0 ? 1 : 0;
} catch (err) {
  console.error('[billing.dunningSweep] fatal:', err);
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
