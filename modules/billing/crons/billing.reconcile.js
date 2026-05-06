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
  { applyJitter },
  { getCronJitterMaxMs },
] = await Promise.all([
  import('../../../config/index.js'),
  import('../../../lib/services/mongoose.js'),
  import('../lib/billing.cron-utils.js'),
  import('../lib/billing.constants.js'),
]);

if (!config?.billing?.meterMode) {
  console.log('[billing.reconcile] meterMode disabled — skipping.');
  process.exit(0);
}

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
  console.log(
    `[billing.reconcile] done — checked: ${result.checked}, divergences: ${result.divergences}, errors: ${result.errors}`,
  );
  process.exitCode = result.errors > 0 ? 1 : 0;
} catch (err) {
  console.error('[billing.reconcile] fatal:', err);
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
