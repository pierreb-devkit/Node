/**
 * Cron script — extra balance expiration sweep.
 *
 * Finds organizations with expired topup ledger entries that have not yet been
 * offset by a matching expiration entry, then calls BillingExtraService.expireOldEntries
 * for each.
 *
 * No-op when config.billing.meterMode === false (default).
 * Intended to run as a Kubernetes CronJob — see modules/billing/crons/README.md.
 *
 * Usage:
 *   NODE_ENV=production node modules/billing/crons/billing.extrasExpiration.js
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
  logger.info('[cron.extrasExpiration] meterMode disabled — skipping.');
  process.exit(0);
}

const startMs = Date.now();
logger.info('[cron.extrasExpiration] start');

try {
  await applyJitter(getCronJitterMaxMs());
  await mongooseService.connect();

  const [{ default: BillingExtraService }, { default: BillingExtraBalanceRepository }] =
    await Promise.all([
      import('../services/billing.extra.service.js'),
      import('../repositories/billing.extraBalance.repository.js'),
    ]);

  const now = new Date();
  const orgIds = await BillingExtraBalanceRepository.findOrgsWithExpiringTopups(now);

  let processed = 0;
  let errors = 0;

  for (const orgId of orgIds) {
    try {
      const added = await BillingExtraService.expireOldEntries(orgId);
      logger.info('[cron.extrasExpiration] org processed', { orgId: String(orgId), entriesAdded: added });
      processed += 1;
    } catch (err) {
      errors += 1;
      logger.error('[cron.extrasExpiration] expireOldEntries failed', { orgId: String(orgId), err });
    }
  }

  logger.info('[cron.extrasExpiration] complete', { processed, errors, durationMs: Date.now() - startMs });
  process.exitCode = errors > 0 ? 1 : 0;
} catch (err) {
  logger.error('[cron.extrasExpiration] failed', { err });
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
