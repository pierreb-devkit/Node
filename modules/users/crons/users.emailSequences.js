/**
 * Cron script — config-declared product email sequences (#4163).
 *
 * Reads `config.users.emailSequences` (default `{}` ⇒ no-op) and, for each
 * sequence and step, mails every verified, non-opted-out user whose account
 * age (UTC calendar days) equals `step.day` AND whose `createdAt >= startAt`.
 * Sending itself goes through `UserService.sendProductMail`, which already
 * skips an unverified or opted-out user and attaches the List-Unsubscribe
 * headers.
 *
 * Recipients are walked in `_id`-ordered pages (`UserRepository.findPage`) —
 * never one unbounded array load — with the per-step `createdAt` range and
 * the opt-out/verified check both pushed into the page query itself, so a
 * day with no matching users costs one empty query instead of a full scan.
 *
 * No sent marker: a day the cron didn't run for (downtime, or a sequence
 * added after the fact) is not caught up — that step simply never fires for
 * the users it would have matched that day. Accepted (#4163).
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

// Page size for the per-step recipient walk — same magic number as
// `UserService.announce`'s ANNOUNCE_PAGE_SIZE (#4162), kept as a local
// constant here since that one is module-private.
const PAGE_SIZE = 200;

const LOCK_NAME = 'users.emailSequences';
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 min — comparable scale to billing.dunningSweep

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
      const [{ default: UserRepository }, { default: UserService }, { EmailKind }, { stepCreatedAtRange, buildStepFilter }] = await Promise.all([
        import('../repositories/users.repository.js'),
        import('../services/users.service.js'),
        import('../models/users.emailPreferences.schema.js'),
        import('../utils/emailSequencesCron.js'),
      ]);

      const now = new Date();
      let sent = 0;
      let errors = 0;

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

          const filter = buildStepFilter({ kind: parsedKind, ...range });
          // createdAt is NOT in the projection — the day-match is already applied
          // as a DB-side range on createdAt (see buildStepFilter above);
          // sendProductMail never reads it.
          const select = '_id email emailVerified emailPreferences';

          let afterId;
          let page;
          do {
            page = await UserRepository.findPage(filter, { afterId, limit: PAGE_SIZE, select });

            for (const recipient of page) {
              try {
                // Sequential on purpose, same as UserService.announce — never parallel
                // (avoid bursting the mailer provider's rate limit).
                const result = await UserService.sendProductMail(recipient, {
                  kind: parsedKind,
                  template: step.template,
                  subject: step.subject,
                  from: sequence.from,
                  replyTo: sequence.replyTo,
                });
                if (result) sent += 1;
              } catch (err) {
                errors += 1;
                // recipient is a lean object (no `id` virtual) — _id is the only identifier available.
                logger.warn('[cron.emailSequences] send failed for one recipient', {
                  userId: String(recipient._id),
                  sequence: name,
                  day: step.day,
                  message: err?.message,
                  stack: err?.stack,
                });
              }
            }

            if (page.length > 0) afterId = page[page.length - 1]._id;
          } while (page.length === PAGE_SIZE);
        }
      }

      logger.info('[cron.emailSequences] complete', { sent, errors, durationMs: Date.now() - startMs });
      process.exitCode = errors > 0 ? 1 : 0;
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
  logger.error('[cron.emailSequences] failed', { err: err?.message, stack: err?.stack });
  process.exitCode = 1;
} finally {
  await mongooseService.disconnect?.();
}
process.exit(process.exitCode ?? 0);
