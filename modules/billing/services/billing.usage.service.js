/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';
import UsageRepository from '../repositories/billing.usage.repository.js';
import BillingSubscriptionRepository from '../repositories/billing.subscription.repository.js';
import BillingPlanService from './billing.plan.service.js';
import BillingExtraService from './billing.extra.service.js';
import billingEvents from '../lib/events.js';
import { currentWeekKey } from '../lib/billing.isoWeek.js';
import { getAlertThresholdPercents, getDefaultPlanId } from '../lib/billing.constants.js';

/**
 * Compute the current month string in YYYY-MM format.
 * @returns {String} e.g. '2026-03'
 */
const currentMonth = () => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

const thresholdFields = {
  80: 'alertedAt80',
  100: 'alertedAt100',
};

// Credit-balance alerts (#4117) support only 80%/100% — same supported set as the
// weekly-quota alertedAtN schema fields above (billing.init.js warns at boot on any
// other configured value already; this mirrors that filter for the stateless path).
const SUPPORTED_CREDIT_ALERT_THRESHOLDS = new Set([80, 100]);

/**
 * @desc Increment a usage counter for the given organization (current month).
 *              Hardens the repository's silent-null anomaly (#3991 follow-up):
 *              `UsageRepository.increment` can return `null` when its
 *              duplicate-key retry's exact-match filter finds nothing — meaning
 *              the write was lost. This should not happen in normal operation
 *              post-#3991 (the (organizationId, weekKey) index no longer
 *              collides across legacy documents for the same org, and the
 *              retry filter exactly matches what a winning concurrent upsert
 *              on the SAME org+month would have just created), so hitting it
 *              now signals a genuine anomaly worth operator visibility — not a
 *              thrown error, since no caller in this repo (or, being public
 *              devkit API, any downstream consumer we cannot audit here) ever
 *              treated a non-null return as guaranteed, and throwing would be
 *              a breaking behavior change for a generic stack module. Per the
 *              silent-catch convention (a swallowed write failure must never
 *              be invisible), this converts the silent null into a LOUD,
 *              logged one instead.
 * @param {String} organizationId - The organization ID.
 * @param {String} key - The counter key to increment.
 * @param {Number} amount - The amount to increment by.
 * @returns {Promise<Object|null>} The updated usage document, or `null` on the
 *   (now logged) anomalous lost-write case.
 */
const increment = async (organizationId, key, amount) => {
  const month = currentMonth();
  const doc = await UsageRepository.increment(organizationId, month, key, amount);
  if (!doc) {
    logger.error('[billing.usage] increment lost a write — duplicate-key retry matched no document', {
      organizationId,
      month,
      key,
      amount,
    });
  }
  return doc;
};

/**
 * @desc Get usage for the given organization (current month).
 * @param {String} organizationId - The organization ID.
 * @returns {Promise<Object>} The usage document or an object with empty counters.
 */
const get = async (organizationId) => {
  const month = currentMonth();
  const usage = await UsageRepository.get(organizationId, month);
  return usage || { organizationId, month, counters: {} };
};

/**
 * @desc Reset usage counters for the given organization (current month).
 * @param {String} organizationId - The organization ID.
 * @returns {Promise<Object|null>} The updated usage document or null.
 */
const reset = (organizationId) => UsageRepository.reset(organizationId, currentMonth());

/**
 * @function incrementMeter
 * @description Full meter attribution flow for a given organization.
 *              1. Computes the current ISO weekKey.
 *              2. Fetches the active plan snapshot (meterQuota + planVersion) from config.
 *              3. Calls repo.incrementMeter atomically with replay protection.
 *              4. If quota is exceeded, debits extras balance directly (atomic single-doc).
 *                 On debit failure, logs a warning — usage is already counted.
 *              5. Detects configured threshold crossings (emits meter.threshold_crossed event, once per cycle).
 *              6. On a one-shot signup-grant plan (meterQuota=0), detects extras-balance
 *                 threshold crossings against the debit's own pre/post balance and emits
 *                 billing.extras.balance_threshold_crossed (stateless, re-fires after a credit).
 *
 *              Returns applied=false when the idempotencyKey was already consumed (replay).
 *
 * @param {string} organizationId - The organization ObjectId (string).
 * @param {number} units - Meter units to attribute.
 * @param {Object} breakdown - Feature-keyed breakdown: { featureKey: units }.
 * @param {string} idempotencyKey - Unique key for replay protection (usually history._id).
 * @returns {Promise<{applied: boolean, meterUsed: number, meterQuota: number, extrasConsumed: number, alertCrossed: string|null}>}
 *   `alertCrossed` is the last threshold emitted this call (lowest value when multiple thresholds crossed in one jump,
 *   e.g. 0%→150% emits both 80 and 100 — alertCrossed='80'). Informational only; events are the authoritative signal.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const incrementMeter = async (organizationId, units, breakdown, idempotencyKey) => {
  if (!config?.billing?.meterMode) {
    return { applied: false, meterUsed: 0, meterQuota: 0, extrasConsumed: 0, alertCrossed: null };
  }

  const weekKey = currentWeekKey();
  const monthKey = currentMonth();

  // Fetch active plan for quota snapshot — config-static, no DB read
  const subscription = await BillingSubscriptionRepository.findPlan(organizationId);
  const planId = subscription?.plan ?? getDefaultPlanId();
  const activePlan = BillingPlanService.getActivePlan(planId);
  const meterQuota = activePlan?.meterQuota ?? 0;
  const planVersion = activePlan?.version ?? null;

  // Compute reset date: start of next week from now
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayOfWeek = d.getUTCDay() || 7; // 1=Mon, 7=Sun
  const daysUntilNextMonday = 8 - dayOfWeek;
  const resetAt = new Date(d.getTime() + daysUntilNextMonday * 24 * 60 * 60 * 1000);

  const baseSnapshot = { month: monthKey, meterQuota, planVersion, resetAt };

  const updatedDoc = await UsageRepository.incrementMeter(
    organizationId,
    weekKey,
    units,
    breakdown,
    idempotencyKey,
    baseSnapshot,
  );

  if (!updatedDoc) {
    // Replay — idempotencyKey already consumed
    const existing = await UsageRepository.findByWeek(organizationId, weekKey);
    return {
      applied: false,
      meterUsed: existing?.meterUsed ?? 0,
      // Live plan quota (fetched above), not the stored snapshot — same rationale as the
      // non-replay path below: the stored week-doc snapshot goes stale after a mid-week
      // plan change, so a replayed call must not report a pre-rotation quota either.
      meterQuota,
      extrasConsumed: 0,
      alertCrossed: null,
    };
  }

  const newMeterUsed = updatedDoc.meterUsed ?? 0;
  // Use the LIVE plan quota (fetched above), not updatedDoc.meterQuota — the stored
  // week-doc snapshot goes stale after a mid-week plan change: the live plan config
  // is authoritative for overflow decisions (mirrors the display fix in billing.controller.js).
  const effectiveQuota = meterQuota;

  // Overflow detection: units consumed beyond the plan quota go to extras.
  // Free plan (effectiveQuota === 0): every unit must be debited from extras —
  // requireQuota middleware lets the request through only when extrasBalance > 0,
  // so reaching this branch means the org pays for usage from its extras pack.
  // Without this branch the extras balance would never decrease on free plans
  // (infinite usage from a $5 pack — money leak).
  let extrasConsumed = 0;
  if (effectiveQuota === 0) {
    extrasConsumed = units;
  } else if (newMeterUsed > effectiveQuota) {
    const previousUsed = Math.max(0, newMeterUsed - units);
    const overflowStart = Math.max(previousUsed, effectiveQuota);
    extrasConsumed = newMeterUsed - overflowStart;
  }

  // Atomic extras debit — best-effort on the hot path; log and continue on failure
  if (extrasConsumed > 0) {
    try {
      const debitResult = await BillingExtraService.debit(organizationId, extrasConsumed, idempotencyKey);
      if (debitResult.applied === false && debitResult.reason !== 'duplicate_step') {
        // Debit unexpectedly silenced — not a replay. Log for monitoring.
        logger.error('[billing.usage] extras debit unexpectedly not applied', {
          organizationId,
          extrasConsumed,
          idempotencyKey,
          reason: debitResult.reason,
        });
      }

      // Sanity ceiling — runaway negative balance detection (Opus H1).
      // A cachedBalance below -10 × meterQuota means something is deeply wrong:
      // either the quota gating failed upstream, a bug is accumulating spurious debits,
      // or the plan snapshot is stale. Emit an alert for ops; the debit was already applied
      // (we do not block it — the usage write already committed above).
      if (debitResult.applied && debitResult.doc) {
        const RUNAWAY_MULTIPLIER = 10;
        const runawayThreshold = -(RUNAWAY_MULTIPLIER * effectiveQuota);
        const currentBalance = debitResult.doc.cachedBalance;
        // Only check when quota > 0; free plans (quota=0) have no meaningful threshold.
        if (effectiveQuota > 0 && currentBalance < runawayThreshold) {
          logger.error('[billing.extra] runaway negative balance detected — possible debit loop or quota gate bypass', {
            organizationId,
            currentBalance,
            planQuota: effectiveQuota,
            attemptedDebit: extrasConsumed,
            runawayThreshold,
          });
          try {
            billingEvents.emit('billing.extras.runaway_debit', {
              organizationId,
              currentBalance,
              planQuota: effectiveQuota,
              attemptedDebit: extrasConsumed,
            });
          } catch (evtErr) {
            logger.error('[billing.usage] billing.extras.runaway_debit listener failed', {
              error: evtErr?.message ?? String(evtErr),
            });
          }
        }

        // Credit-balance alerts (#4117) — plans without a weekly quota (meterQuota=0,
        // a one-shot signupGrant). There is no weekly usage doc to dedup against here
        // (alertedAt80/alertedAt100 are scoped to a week and would re-fire every week
        // against a lifetime balance — see billing.email.js), so this is stateless:
        // detect a crossing purely from THIS debit's own pre/post balance snapshot.
        // A later credit (pack, referral) that pushes the balance back above a level
        // lets the next crossing alert again — intended.
        // Limitation: "% of grant" only makes sense for the one-shot signup grant; once
        // a pack tops up the same cachedBalance the denominator is ambiguous, so this is
        // scoped to the signup-grant case only (see README.md).
        if (
          effectiveQuota === 0
          && Number.isFinite(activePlan?.signupGrant)
          && activePlan.signupGrant > 0
        ) {
          const post = currentBalance;
          const pre = post + extrasConsumed;
          // DESC order (100 before 80, from getAlertThresholdPercents()) — emit only the
          // deepest crossing per debit (one debit crossing both levels → one email).
          for (const threshold of getAlertThresholdPercents()) {
            if (!SUPPORTED_CREDIT_ALERT_THRESHOLDS.has(threshold)) continue;
            // `signupGrant * (100 - threshold) / 100`, not `(1 - threshold/100) * signupGrant` —
            // the latter hits float imprecision at common values (e.g. 500 * (1 - 80/100) =
            // 99.99999999999997, not 100), which would silently miss an exact boundary crossing.
            const level = (activePlan.signupGrant * (100 - threshold)) / 100;
            if (!(pre > level && post <= level)) continue;
            try {
              billingEvents.emit('billing.extras.balance_threshold_crossed', {
                organizationId,
                threshold,
                remaining: Math.max(0, post),
                planId,
              });
            } catch (evtErr) {
              logger.error('[billing.usage] billing.extras.balance_threshold_crossed listener failed', {
                error: evtErr?.message ?? String(evtErr),
              });
            }
            break;
          }
        }
      }
    } catch (err) {
      // Usage is already counted. Log for monitoring — a retry cron or manual backfill
      // can reconcile if needed. Never let a debit failure block the usage write.
      logger.warn('[billing.usage] extras debit failed (usage already counted)', {
        organizationId,
        idempotencyKey,
        err: err?.message ?? String(err),
      });
    }
  }

  // Threshold detection — emit configured thresholds, deduplicated per cycle
  let alertCrossed = null;

  if (effectiveQuota > 0) {
    const pct = (newMeterUsed / effectiveQuota) * 100;
    // loop runs DESC (e.g. [100, 80] from getAlertThresholdPercents()); alertCrossed retains the last (lowest) marked threshold by design.
    for (const threshold of getAlertThresholdPercents()) {
      const field = thresholdFields[threshold];
      if (!field) {
        logger.warn('[billing.usage] threshold has no schema field — skipping', { threshold });
        continue;
      }
      // updatedDoc is pre-mark snapshot; DB-side dedup enforced by markThreshold conditional update.
      if (pct < threshold || updatedDoc[field]) continue;

      let marked = false;
      try {
        const markResult = await UsageRepository.markThreshold(updatedDoc._id, field);
        marked = markResult?.modifiedCount > 0;
      } catch (err) {
        logger.warn('[billing.usage] threshold mark failed, skipping emit', { threshold, err: err?.message ?? String(err) });
      }
      if (marked) {
        alertCrossed = String(threshold);
        billingEvents.emit('meter.threshold_crossed', {
          organizationId,
          weekKey,
          threshold,
          meterUsed: newMeterUsed,
          meterQuota: effectiveQuota,
        });
      }
    }
  }

  return {
    applied: true,
    meterUsed: newMeterUsed,
    meterQuota: effectiveQuota,
    extrasConsumed,
    alertCrossed,
  };
};

/**
 * @function getMeter
 * @description Return the current week's meter document for an organization,
 *              including the plan quota snapshot.
 * @param {string} organizationId - The organization ObjectId (string).
 * @returns {Promise<Object|null>} The usage document with meter fields, or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getMeter = async (organizationId) => {
  if (!config?.billing?.meterMode) return null;
  const weekKey = currentWeekKey();
  return UsageRepository.findByWeek(organizationId, weekKey);
};

export default {
  increment,
  get,
  reset,
  currentWeekKey,
  incrementMeter,
  getMeter,
};
