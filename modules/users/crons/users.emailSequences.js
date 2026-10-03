/**
 * Cron script — config-declared product email sequences (#4163).
 *
 * Reads `config.users.emailSequences` (default `{}` ⇒ no-op) and, for each
 * sequence and step, mails every verified, non-opted-out user whose account
 * age (UTC calendar days) equals `step.day` AND whose `createdAt >= startAt`.
 * Sending itself goes through `UserService.walkSendProductMail` — the same
 * paginate → send → catch → count walk `UserService.announce` uses (#4162,
 * #4163) — which calls `UserService.sendProductMail` per recipient; that
 * function already skips an unverified or opted-out user and attaches the
 * List-Unsubscribe headers.
 *
 * Recipients are walked in `_id`-ordered pages (`UserRepository.findPage`,
 * via that shared helper) — never one unbounded array load — with the
 * per-step `createdAt` range and the opt-out/verified check both pushed into
 * the page query itself, so a day with no matching users costs one empty
 * query instead of a full scan.
 *
 * No sent marker: a day the cron didn't run for (downtime, or a sequence
 * added after the fact) is not caught up — that step simply never fires for
 * the users it would have matched that day. Accepted (#4163). The flip side
 * of having no sent marker is that THIS SCRIPT MUST NEVER EXIT NON-ZERO once
 * it starts sending: a restart (or a retried Job) would re-mail every
 * recipient this run already reached, with no way to tell who that was. So
 * a per-recipient send failure, a per-step template or DB problem, are all
 * logged and swallowed — never rethrown — once the lock is held; only a
 * fatal failure BEFORE any sending could possibly have started (config load,
 * DB connect, lock acquire error) exits 1. See `README.md`'s "Kubernetes
 * CronJob example" for why that also means `restartPolicy: Never` +
 * `backoffLimit: 0` downstream, not the usual `OnFailure` + retries.
 *
 * Standalone bootstrap copied from `modules/billing/crons/billing.dunningSweep.js`'s
 * shape — this module does NOT import billing's `lib/billing.cron-utils.js`
 * (cross-module import of another module's internals); `lib/services/distributedLock.js`
 * is the only shared piece, same as every billing cron already uses it.
 *
 * Usage:
 *   NODE_ENV=production node modules/users/crons/users.emailSequences.js
 */

import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const [
  { default: config },
  { default: mongooseService },
  { default: logger },
  { acquireLock, releaseLock },
] = await Promise.all([
  import('../../../config/index.js'),
  import('../../../lib/services/mongoose.js'),
  import('../../../lib/services/logger.js'),
  import('../../../lib/services/distributedLock.js'),
]);

const sequences = config?.users?.emailSequences ?? {};

if (Object.keys(sequences).length === 0) {
  logger.info('[cron.emailSequences] no sequences configured — skipping.');
  process.exit(0);
}

const LOCK_NAME = 'users.emailSequences';
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 min — see README.md's "Concurrency control" for how to size this.

const startMs = Date.now();
logger.info('[cron.emailSequences] start', { sequences: Object.keys(sequences).length });

let lockHolder = null;
try {
  await mongooseService.loadModels();
  await mongooseService.connect();

  lockHolder = `${process.env.HOSTNAME ?? 'unknown'}:${randomUUID()}`;
  const acquired = await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder: lockHolder });
  if (!acquired) {
    logger.info('[cron.emailSequences] lock held by another pod, skipping');
    process.exitCode = 0;
  } else {
    try {
      const [{ walkSendProductMail }, { EmailKind }, { stepCreatedAtRange, buildStepFilter }, { default: mailer }] = await Promise.all([
        import('../services/users.service.js'),
        import('../models/users.emailPreferences.schema.js'),
        import('../utils/emailSequencesCron.js'),
        import('../../../lib/helpers/mailer/index.js'),
      ]);

      const now = new Date();
      let sent = 0;
      let failed = 0;
      let stepErrors = 0;

      for (const [name, sequence] of Object.entries(sequences)) {
        const startAt = new Date(sequence?.startAt);
        if (!sequence || Number.isNaN(startAt.getTime()) || !Array.isArray(sequence.steps)) {
          logger.warn('[cron.emailSequences] sequence skipped — malformed config', { sequence: name });
          continue;
        }

        let parsedKind;
        try {
          parsedKind = EmailKind.parse(sequence.kind);
        } catch {
          logger.warn('[cron.emailSequences] sequence skipped — invalid kind', { sequence: name, kind: sequence.kind });
          continue;
        }

        for (const step of sequence.steps) {
          let range;
          try {
            range = stepCreatedAtRange({ now, day: step?.day, startAt });
          } catch (err) {
            logger.warn('[cron.emailSequences] step skipped — invalid day', { sequence: name, day: step?.day, message: err?.message });
            continue;
          }
          if (!range) continue; // this step's whole calendar day predates startAt — no one can match

          // Validate the template ONCE per step, resolved the way the mailer itself
          // resolves/renders it (its public `render`) — a broken template key would
          // otherwise only surface inside walkSendProductMail's per-recipient
          // try/catch, logging the identical warning once per matching recipient
          // instead of once for the whole step. Runs even if the mailer itself isn't
          // configured yet (sendProductMail's own isConfigured() check still means no
          // mail actually goes out either way) — surfacing a broken template is more
          // useful than silently swallowing it.
          try {
            await mailer.render(step.template, {}, { subject: step.subject });
          } catch (err) {
            logger.warn('[cron.emailSequences] step skipped — template failed to resolve', {
              sequence: name,
              day: step.day,
              template: step.template,
              message: err?.message,
            });
            continue;
          }

          const filter = buildStepFilter({ kind: parsedKind, ...range });

          // Per-step isolation (#4163): a transient DB error walking THIS step's
          // recipients (findPage) must not abort the sequences/steps still to come —
          // log and move on, same as a per-recipient send failure already does inside
          // walkSendProductMail.
          try {
            const { sent: stepSent, failed: stepFailed } = await walkSendProductMail(
              filter,
              { kind: parsedKind, template: step.template, subject: step.subject, from: sequence.from, replyTo: sequence.replyTo },
              { logLabel: '[cron.emailSequences]', logContext: { sequence: name, day: step.day } },
            );
            sent += stepSent;
            failed += stepFailed;
            logger.info('[cron.emailSequences] step complete', { sequence: name, day: step.day, sent: stepSent, failed: stepFailed });
          } catch (err) {
            stepErrors += 1;
            logger.error('[cron.emailSequences] step aborted — DB error walking recipients, moving to next step', {
              sequence: name,
              day: step.day,
              message: err?.message,
              stack: err?.stack,
            });
          }
        }
      }

      logger.info('[cron.emailSequences] complete', { sent, failed, stepErrors, durationMs: Date.now() - startMs });
      // Never non-zero past this point: per-recipient and per-step failures are
      // logged above but must not fail the Job — see the top-of-file doc comment
      // (no sent marker ⇒ a retry would re-mail everyone this run already reached).
      process.exitCode = 0;
    } finally {
      // releaseLock failure is non-fatal: lock auto-expires on TTL.
      // Log separately to preserve any original work error.
      try {
        await releaseLock({ name: LOCK_NAME, holder: lockHolder });
      } catch (releaseErr) {
        logger.error('[cron.emailSequences] failed to release lock — will auto-expire on TTL', {
          err: releaseErr,
          cron: LOCK_NAME,
        });
      }
    }
  }
} catch (err) {
  // Reached only by a fatal startup failure (config load, DB connect, lock acquire
  // error) — nothing above this catch block ever rethrows once the lock is held.
  logger.error('[cron.emailSequences] failed', { err: err?.message, stack: err?.stack });
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
