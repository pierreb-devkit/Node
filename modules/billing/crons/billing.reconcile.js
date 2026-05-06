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
  logger.info('[cron.reconcile] meterMode disabled — skipping.');
  process.exit(0);
}

const startMs = Date.now();
logger.info('[cron.reconcile] start');

await applyJitter(getCronJitterMaxMs());

try {
  await mongooseService.loadModels();
  await mongooseService.connect();

  const [
    { default: BillingReconcileService },
  ] = await Promise.all([
    import('../services/billing.reconcile.service.js'),
  ]);

  const result = await BillingReconcileService.runReconciliation();
  logger.info('[cron.reconcile] complete', { checked: result.checked, divergences: result.divergences, errors: result.errors, durationMs: Date.now() - startMs });
  process.exitCode = result.errors > 0 ? 1 : 0;
} catch (err) {
  logger.error('[cron.reconcile] failed', { err });
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
