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
 * With `billing.referral.link` on (#4214) it also sweeps link signups — users with
 * `referredBy` and no accepted invitation (keys `referral:link:<userId>:referee|referrer:<referrerId>`)
 * — back-filled via BillingReferralService.grantForLink, which owns the invite-wins
 * and per-referrer cap rules (a capped user is never a pending miss); each referrer's
 * remaining budget is computed once per run. Needs `invitations.maxLifetime` (positive
 * integer), else the link set is skipped. Turning `link` on back-fills past link signups,
 * bounded by that cap.
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
  /**
   * Gate predicate for this cron — true when the referral program is enabled.
   * @param {object} config - Loaded app config.
   * @returns {boolean} True when config.billing.referral.enabled is truthy.
   */
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
        { default: InvitationsService },
        { default: UserService },
      ] = await Promise.all([
        import('../services/billing.referral.service.js'),
        import('../repositories/billing.extraBalance.repository.js'),
        import('../../invitations/services/invitations.service.js'),
        import('../../users/services/users.service.js'),
      ]);

      const cfg = config.billing.referral;
      const accepted = await InvitationsService.findAccepted();

      // Expected keys per invitation — derived from the service's expectedGrantKeys
      // (the SINGLE rule source shared with grantForInvitation): the cron never
      // re-encodes the side rules, so a new guard (e.g. #3833) can never drift.
      const candidates = [];
      for (const invite of accepted) {
        const expected = BillingReferralService.expectedGrantKeys(invite, cfg).map(({ key }) => key);
        if (expected.length > 0) candidates.push({ invite, expected });
      }

      // Link signups (#4214): users with `referredBy` and NO accepted invitation. Same
      // rule source (expectedGrantKeys); the invite-wins and cap rules live in grantForLink.
      const linkCandidates = [];
      const linkCap = cfg.link ? BillingReferralService.getLinkCap() : null;
      if (cfg.link && !linkCap) {
        logger.warn('[cron.referralReconcile] billing.referral.link needs invitations.maxLifetime (a positive integer) — link signups skipped');
      } else if (cfg.link) {
        const invitedIds = new Set(accepted.map((invite) => String(invite.acceptedUserId)));
        // Lean read: only the ids and the referrer, oldest first (the order the cap spends in).
        const referred = await UserService.findWithFilter({ referredBy: { $ne: null } }, '_id referredBy');
        for (const user of referred) {
          if (invitedIds.has(String(user._id))) continue;
          const link = { kind: 'link', userId: String(user._id), referredBy: String(user.referredBy) };
          const expected = BillingReferralService.expectedGrantKeys(link, cfg).map(({ key }) => key);
          const referrerKey = BillingReferralService.expectedGrantKeys(link, cfg).find(({ side }) => side === 'referrer')?.key;
          if (expected.length > 0) linkCandidates.push({ link, expected, referrerKey });
        }
        linkCandidates.sort((x, y) => (x.link.userId < y.link.userId ? -1 : 1));
      }

      const allKeys = [...candidates, ...linkCandidates].flatMap((c) => c.expected);
      const existing = new Set(await BillingExtraBalanceRepository.findExistingRefIds(allKeys));

      let backfilled = 0;
      let pending = 0;
      let errors = 0;

      /**
       * Fold one grant result into the run counters.
       * @param {{referrer?: Object, referee?: Object}} result - Result of a grant call.
       * @param {Object} logMeta - Identifiers logged on a back-fill.
       * @returns {void}
       */
      const tally = (result, logMeta) => {
        const sides = [result.referrer, result.referee].filter(Boolean);
        const applied = sides.filter((s) => s.applied).length;
        // `no_organization` = the actor has no workspace yet (e.g. email verification
        // pending) — stays pending, retried on the next run once the org exists.
        const waiting = sides.filter((s) => s.reason === 'no_organization').length;
        if (applied > 0) {
          backfilled += applied;
          logger.info('[cron.referralReconcile] back-filled', { ...logMeta, applied });
        }
        if (waiting > 0) pending += waiting;
      };

      // Each referrer's remaining link budget (cap - grants already on their ledger) is
      // read once per run and spent in-run; candidates beyond it are skipped before
      // grantForLink (which re-checks the cap itself) and are not pending. A user whose own referrer grant already landed is free (finishing
      // the referee side never spends budget).
      const budgets = new Map();
      for (const { link, expected, referrerKey } of linkCandidates) {
        if (expected.every((key) => existing.has(key))) continue; // fully granted
        try {
          if (!budgets.has(link.referredBy)) budgets.set(link.referredBy, await BillingReferralService.linkBudget(link.referredBy, linkCap));
          const budget = budgets.get(link.referredBy);
          if (budget.skipped) continue; // referrer has no workspace yet — retried next run
          if (!existing.has(referrerKey)) {
            if (budget.remaining <= 0) continue; // cap reached — not a miss
            budget.remaining -= 1;
          }
          tally(await BillingReferralService.grantForLink(link), { userId: link.userId });
        } catch (err) {
          errors += 1;
          logger.error('[cron.referralReconcile] grantForLink failed', {
            userId: link.userId,
            err: err?.message,
            stack: err?.stack,
          });
        }
      }

      for (const { invite, expected } of candidates) {
        if (expected.every((key) => existing.has(key))) continue; // fully granted
        try {
          const result = await BillingReferralService.grantForInvitation({
            invitationId: String(invite._id),
            invitedBy: invite.invitedBy ? String(invite.invitedBy) : null,
            acceptedUserId: invite.acceptedUserId ? String(invite.acceptedUserId) : null,
          });
          tally(result, { invitationId: String(invite._id) });
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
        linkCandidates: linkCandidates.length,
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
