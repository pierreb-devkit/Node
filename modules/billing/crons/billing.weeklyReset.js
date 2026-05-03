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

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const [
  { default: config },
  { default: mongooseService },
  { applyJitter },
  { getCronJitterMaxMs },
] = await Promise.all([
  import('../../../config/index.js'),
  import('../../../lib/services/mongoose.js'),
  import('../lib/billing.cron-utils.js'),
  import('../lib/billing.constants.js'),
]);

if (!config?.billing?.meterMode) {
  console.log('[billing.weeklyReset] meterMode disabled — skipping.');
  process.exit(0);
}

await applyJitter(getCronJitterMaxMs());

try {
  await mongooseService.connect();

  const { default: BillingResetService } = await import('../services/billing.reset.service.js');

  const result = await BillingResetService.resetAllDue();
  console.log(`[billing.weeklyReset] done — processed: ${result.processed}, errors: ${result.errors}`);
  process.exitCode = result.errors > 0 ? 1 : 0;
} catch (err) {
  console.error('[billing.weeklyReset] fatal:', err);
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
