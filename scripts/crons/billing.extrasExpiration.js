/**
 * Cron script — extra balance expiration sweep.
 *
 * Finds organizations with expired topup ledger entries that have not yet been
 * offset by a matching expiration entry, then calls BillingExtraService.expireOldEntries
 * for each.
 *
 * No-op when config.billing.meterMode === false (default).
 * Intended to run as a Kubernetes CronJob — see scripts/crons/README.md.
 *
 * Usage:
 *   NODE_ENV=production node scripts/crons/billing.extrasExpiration.js
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const [{ default: config }, { default: mongooseService }] = await Promise.all([
  import('../../config/index.js'),
  import('../../lib/services/mongoose.js'),
]);

if (!config?.billing?.meterMode) {
  console.log('[billing.extrasExpiration] meterMode disabled — skipping.');
  process.exit(0);
}

try {
  await mongooseService.connect();

  const [{ default: BillingExtraService }, { default: BillingExtraBalanceRepository }] =
    await Promise.all([
      import('../../modules/billing/services/billing.extra.service.js'),
      import('../../modules/billing/repositories/billing.extraBalance.repository.js'),
    ]);

  const now = new Date();
  const orgIds = await BillingExtraBalanceRepository.findOrgsWithExpiringTopups(now);

  let processed = 0;
  let errors = 0;

  for (const orgId of orgIds) {
    try {
      const added = await BillingExtraService.expireOldEntries(orgId);
      console.log(`[billing.extrasExpiration] org ${orgId}: ${added} expiration entries added`);
      processed += 1;
    } catch (err) {
      errors += 1;
      console.error(`[billing.extrasExpiration] expireOldEntries failed for org ${orgId}:`, err);
    }
  }

  console.log(`[billing.extrasExpiration] done — processed: ${processed}, errors: ${errors}`);
  process.exitCode = errors > 0 ? 1 : 0;
} catch (err) {
  console.error('[billing.extrasExpiration] fatal:', err);
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
