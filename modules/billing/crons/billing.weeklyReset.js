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
  { default: logger },
  { applyJitter },
  { getCronJitterMaxMs },
] = await Promise.all([
  import('../../../config/index.js'),
  import('../../../lib/services/mongoose.js'),
  import('../../../lib/services/logger.js'),
  import('../lib/billing.cron-utils.js'),
  import('../lib/billing.constants.js'),
]);

if (!config?.billing?.meterMode) {
  logger.info('[cron.weeklyReset] meterMode disabled — skipping.');
  process.exit(0);
}

const startMs = Date.now();
logger.info('[cron.weeklyReset] start');

try {
  await applyJitter(getCronJitterMaxMs());
  await mongooseService.loadModels();
  await mongooseService.connect();

  const { default: BillingResetService } = await import('../services/billing.reset.service.js');

  const result = await BillingResetService.resetAllDue();
  logger.info('[cron.weeklyReset] complete', { processed: result.processed, errors: result.errors, durationMs: Date.now() - startMs });
  process.exitCode = result.errors > 0 ? 1 : 0;
} catch (err) {
  logger.error('[cron.weeklyReset] failed', { err: err?.message, stack: err?.stack });
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
