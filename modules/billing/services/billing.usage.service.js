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

/**
 * @desc Increment a usage counter for the given organization (current month).
 * @param {String} organizationId - The organization ID.
 * @param {String} key - The counter key to increment.
 * @param {Number} amount - The amount to increment by.
 * @returns {Promise<Object>} The updated usage document.
 */
const increment = (organizationId, key, amount) => UsageRepository.increment(organizationId, currentMonth(), key, amount);

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
      meterQuota: existing?.meterQuota ?? meterQuota,
      extrasConsumed: 0,
      alertCrossed: null,
    };
  }

  const newMeterUsed = updatedDoc.meterUsed ?? 0;
  const effectiveQuota = updatedDoc.meterQuota ?? meterQuota;

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
