/**
 * Cron script — retry pending extras debits from the meter outbox.
 *
 * No-op when config.billing.meterMode === false (default).
 * Intended to run as a Kubernetes CronJob every 5 minutes.
 *
 * Usage:
 *   NODE_ENV=production node modules/billing/crons/retry-pending-extras-debit.cron.js
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const [{ default: config }, { default: mongooseService }] = await Promise.all([
  import('../../../config/index.js'),
  import('../../../lib/services/mongoose.js'),
]);

if (!config?.billing?.meterMode) {
  console.log('[billing.retryPendingExtrasDebit] meterMode disabled — skipping.');
  process.exit(0);
}

const { randomInt } = await import('node:crypto');
const jitterMs = randomInt(0, 60_000);
await new Promise((resolve) => setTimeout(resolve, jitterMs));

try {
  await mongooseService.loadModels();
  await mongooseService.connect();

  const { default: BillingMeterOutboxService } = await import('../services/billing.meter.outbox.service.js');
  const result = await BillingMeterOutboxService.retryPendingExtrasDebits(5 * 60 * 1000, 100);

  console.log(
    `[billing.retryPendingExtrasDebit] done — scanned: ${result.scanned}, committed: ${result.committed}, failedAttempts: ${result.failedAttempts}, exhausted: ${result.exhausted}`,
  );
  if (result.exhausted > 0) {
    // Exhausted rows are a handled business outcome (alert event already emitted),
    // not an operational cron failure — log for visibility without failing the job.
    console.warn(`[billing.retryPendingExtrasDebit] exhausted rows (alert emitted): ${result.exhausted}`);
  }
  process.exitCode = 0;
} catch (err) {
  console.error('[billing.retryPendingExtrasDebit] fatal:', err);
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
