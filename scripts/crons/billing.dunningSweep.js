/**
 * Cron script — dunning sweep.
 *
 * Finds subscriptions in 'past_due' status whose pastDueSince is older than 14 days
 * (i.e. the 7-day grace period has elapsed with no payment), transitions them to
 * 'unpaid' + plan 'free', and syncs the Organization.plan field accordingly.
 *
 * No-op when config.billing.meterMode === false (default).
 * Intended to run as a Kubernetes CronJob — see scripts/crons/README.md.
 *
 * Usage:
 *   NODE_ENV=production node scripts/crons/billing.dunningSweep.js
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const [{ default: config }, { default: mongooseService }] = await Promise.all([
  import('../../config/index.js'),
  import('../../lib/services/mongoose.js'),
]);

if (!config?.billing?.meterMode) {
  console.log('[billing.dunningSweep] meterMode disabled — skipping.');
  process.exit(0);
}

await mongooseService.connect();

try {
  const [{ default: mongoose }, { default: BillingSubscriptionRepository }] = await Promise.all([
    import('mongoose'),
    import('../../modules/billing/repositories/billing.subscription.repository.js'),
  ]);

  const Organization = mongoose.model('Organization');

  const now = new Date();
  const threshold = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const staleSubs = await BillingSubscriptionRepository.findStaleDunning(threshold);
  console.log(`[billing.dunningSweep] ${staleSubs.length} stale past_due subscription(s) found`);

  let processed = 0;
  let errors = 0;

  for (const sub of staleSubs) {
    try {
      await BillingSubscriptionRepository.markUnpaid(String(sub._id));

      // Sync Organization.plan to 'free'
      const orgId = String(sub.organization);
      if (mongoose.Types.ObjectId.isValid(orgId)) {
        await Organization.findByIdAndUpdate(orgId, { plan: 'free' }, { runValidators: true }).exec();
      }

      console.log(`[billing.dunningSweep] sub ${sub._id} → unpaid, org ${sub.organization} → free`);
      processed += 1;
    } catch (err) {
      errors += 1;
      console.error(`[billing.dunningSweep] failed for sub ${sub._id}:`, err);
    }
  }

  console.log(`[billing.dunningSweep] done — processed: ${processed}, errors: ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
} catch (err) {
  console.error('[billing.dunningSweep] fatal:', err);
  process.exit(1);
} finally {
  await mongooseService.disconnect?.();
}
