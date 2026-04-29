/**
 * Cron script — weekly meter reset sweep.
 *
 * Iterates active subscriptions and resets the meter for each org whose
 * billing period rolled over within the last 7 days.
 *
 * No-op when config.billing.meterMode === false (default).
 * Intended to run as a Kubernetes CronJob — see scripts/crons/README.md.
 *
 * Usage:
 *   NODE_ENV=production node scripts/crons/billing.weeklyReset.js
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const [{ default: config }, { default: mongooseService }] = await Promise.all([
  import('../../config/index.js'),
  import('../../lib/services/mongoose.js'),
]);

if (!config?.billing?.meterMode) {
  console.log('[billing.weeklyReset] meterMode disabled — skipping.');
  process.exit(0);
}

await mongooseService.connect();

try {
  const { default: BillingResetService } = await import('../../modules/billing/services/billing.reset.service.js');

  const result = await BillingResetService.resetAllDue();
  console.log(`[billing.weeklyReset] done — processed: ${result.processed}, errors: ${result.errors}`);
  process.exit(result.errors > 0 ? 1 : 0);
} catch (err) {
  console.error('[billing.weeklyReset] fatal:', err);
  process.exit(1);
} finally {
  await mongooseService.disconnect?.();
}
