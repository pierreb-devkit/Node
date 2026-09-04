/**
 * Cron script — referral grant reconcile sweep (#3842).
 *
 * The `invitation.accepted` listener in billing.init.js is in-process fire-and-forget:
 * a crash between accept and grant loses the event, and a mailer-configured signup can
 * fire it before the referee's organization exists. This sweep is the truth: it scans
 * ALL `invitations { status:'accepted' }`, diffs the expected grant keys
 * (`referral:<invitationId>:referrer|referee`) against the BillingExtraBalance ledger,
 * and back-fills misses idempotently via BillingReferralService.grantForInvitation
 * (the atomic `ledger.refId` guard makes overlap with the listener harmless).
 *
 * No-op when config.billing.referral.enabled === false (default).
 * Intended to run as a Kubernetes CronJob — see modules/billing/crons/README.md.
 *
 * Usage:
 *   NODE_ENV=production node modules/billing/crons/billing.referralReconcile.js
 */

import { randomUUID } from 'node:crypto';
import { bootstrapCron } from '../lib/billing.cron-utils.js';

const {
  config,
  mongooseService,
  logger,
  applyJitter,
  getCronJitterMaxMs,
  acquireLock,
  releaseLock,
  LOCK_NAME,
  LOCK_TTL_MS,
} = await bootstrapCron({
  isEnabled: (config) => Boolean(config?.billing?.referral?.enabled),
  gateMessage: '[cron.referralReconcile] referral disabled — skipping.',
  lockName: 'billing.referralReconcile',
  lockTtlMs: 10 * 60 * 1000, // 10 min
});

const startMs = Date.now();
logger.info('[cron.referralReconcile] start');

let lockHolder = null;
try {
  await applyJitter(getCronJitterMaxMs());
  await mongooseService.loadModels();
  await mongooseService.connect();

  lockHolder = `${process.env.HOSTNAME ?? 'unknown'}:${randomUUID()}`;
  const acquired = await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder: lockHolder });
  if (!acquired) {
    logger.info('[cron.referralReconcile] lock held by another pod, skipping');
    process.exitCode = 0;
  } else {
    try {
      const [
        { default: BillingReferralService },
        { default: BillingExtraBalanceRepository },
        { default: InvitationRepository },
      ] = await Promise.all([
        import('../services/billing.referral.service.js'),
        import('../repositories/billing.extraBalance.repository.js'),
        import('../../invitations/repositories/invitations.repository.js'),
      ]);

      const cfg = config.billing.referral;
      const accepted = await InvitationRepository.findAccepted();

      // Expected keys per invitation — derived from the service's expectedGrantKeys
      // (the SINGLE rule source shared with grantForInvitation): the cron never
      // re-encodes the side rules, so a new guard (e.g. #3833) can never drift.
      const candidates = [];
      for (const invite of accepted) {
        const expected = BillingReferralService.expectedGrantKeys(invite, cfg).map(({ key }) => key);
        if (expected.length > 0) candidates.push({ invite, expected });
      }

      const allKeys = candidates.flatMap((c) => c.expected);
      const existing = new Set(await BillingExtraBalanceRepository.findExistingRefIds(allKeys));

      let backfilled = 0;
      let pending = 0;
      let errors = 0;

      for (const { invite, expected } of candidates) {
        if (expected.every((key) => existing.has(key))) continue; // fully granted
        try {
          const result = await BillingReferralService.grantForInvitation({
            invitationId: String(invite._id),
            invitedBy: invite.invitedBy ? String(invite.invitedBy) : null,
            acceptedUserId: invite.acceptedUserId ? String(invite.acceptedUserId) : null,
          });
          const sides = [result.referrer, result.referee].filter(Boolean);
          const applied = sides.filter((s) => s.applied).length;
          // `no_organization` = the actor has no workspace yet (e.g. email verification
          // pending) — stays pending, retried on the next run once the org exists.
          const waiting = sides.filter((s) => s.reason === 'no_organization').length;
          if (applied > 0) {
            backfilled += applied;
            logger.info('[cron.referralReconcile] back-filled', { invitationId: String(invite._id), applied });
          }
          if (waiting > 0) pending += waiting;
        } catch (err) {
          errors += 1;
          logger.error('[cron.referralReconcile] grantForInvitation failed', {
            invitationId: String(invite._id),
            err: err?.message,
            stack: err?.stack,
          });
        }
      }

      logger.info('[cron.referralReconcile] complete', {
        accepted: accepted.length,
        backfilled,
        pending,
        errors,
        durationMs: Date.now() - startMs,
      });
      process.exitCode = errors > 0 ? 1 : 0;
    } finally {
      // releaseLock failure is non-fatal: lock auto-expires on TTL.
      // Log separately to preserve any original work error.
      try {
        await releaseLock({ name: LOCK_NAME, holder: lockHolder });
      } catch (releaseErr) {
        logger.error('[cron.referralReconcile] failed to release lock — will auto-expire on TTL', {
          err: releaseErr,
          cron: LOCK_NAME,
        });
      }
    }
  }
} catch (err) {
  logger.error('[cron.referralReconcile] failed', { err: err?.message, stack: err?.stack });
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
