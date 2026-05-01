/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import UsageRepository from '../repositories/billing.usage.repository.js';
import BillingSubscriptionRepository from '../repositories/billing.subscription.repository.js';
import BillingPlanService from './billing.plan.service.js';

/**
 * @function getBillingEvents
 * @description Lazily import the billing events emitter to avoid circular dependency
 *              at module load time. Returns the emitter instance, or null if the
 *              import fails (e.g. events module not available in test env).
 * @async
 * @returns {Promise<import('node:events').EventEmitter|null>} The billing event emitter, or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getBillingEvents = async () => {
  try {
    const { default: billingEvents } = await import('../lib/events.js');
    return billingEvents;
  } catch {
    return null;
  }
};

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

/**
 * @function currentWeekKey
 * @description Compute the current ISO 8601 week key in YYYY-Www format.
 *              ISO week starts on Monday; week 1 contains the first Thursday.
 * @returns {string} e.g. '2026-W18'
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const currentWeekKey = () => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Shift to nearest Thursday (ISO anchor)
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
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
 *              2. Fetches the active plan snapshot (meterQuota + planVersion).
 *              3. Calls repo.incrementMeter atomically with replay protection.
 *              4. If quota is exceeded, overflows into extras balance.
 *              5. Detects 80%/100% threshold crossings (emits meter.threshold_crossed event, once per cycle).
 *
 *              Returns applied=false when the idempotencyKey was already consumed (replay).
 *
 * @param {string} organizationId - The organization ObjectId (string).
 * @param {number} units - Meter units to attribute.
 * @param {Object} breakdown - Feature-keyed breakdown: { featureKey: units }.
 * @param {string} idempotencyKey - Unique key for replay protection (usually history._id).
 * @returns {Promise<{applied: boolean, meterUsed: number, meterQuota: number, extrasConsumed: number, alertCrossed: string|null}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const incrementMeter = async (organizationId, units, breakdown, idempotencyKey) => {
  if (!config?.billing?.meterMode) {
    return { applied: false, meterUsed: 0, meterQuota: 0, extrasConsumed: 0, alertCrossed: null };
  }

  const weekKey = currentWeekKey();
  const monthKey = currentMonth();

  // Fetch active plan for quota snapshot — lean projection (plan field only, no populate)
  const subscription = await BillingSubscriptionRepository.findPlan(organizationId);
  const planId = subscription?.plan ?? config?.billing?.defaultPlan ?? 'free';
  const activePlan = await BillingPlanService.getActivePlan(planId);
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

  // Overflow detection: units consumed beyond the plan quota go to extras
  let extrasConsumed = 0;
  if (effectiveQuota > 0 && newMeterUsed > effectiveQuota) {
    const previousUsed = newMeterUsed - units;
    const overflowStart = Math.max(previousUsed, effectiveQuota);
    extrasConsumed = newMeterUsed - overflowStart;
  }

  // Threshold detection — emit event at 80% and 100%, deduplicated per cycle
  let alertCrossed = null;
  const billingEvents = await getBillingEvents();

  if (effectiveQuota > 0) {
    const pct = newMeterUsed / effectiveQuota;

    if (pct >= 1.0 && !updatedDoc.alertedAt100) {
      // Only emit when we win the dedup race (modifiedCount > 0).
      // If another pod already set alertedAt100, markThreshold returns modifiedCount=0 — skip emit.
      let marked = false;
      try {
        const markResult = await UsageRepository.markThreshold(updatedDoc._id, 'alertedAt100');
        marked = markResult?.modifiedCount > 0;
      } catch {
        // Best-effort — if mark fails, skip emit to avoid double-fire
      }
      if (marked) {
        alertCrossed = '100';
        if (billingEvents) {
          billingEvents.emit('meter.threshold_crossed', {
            organizationId,
            weekKey,
            threshold: 100,
            meterUsed: newMeterUsed,
            meterQuota: effectiveQuota,
          });
        }
      }
    } else if (pct >= 0.8 && !updatedDoc.alertedAt80) {
      let marked = false;
      try {
        const markResult = await UsageRepository.markThreshold(updatedDoc._id, 'alertedAt80');
        marked = markResult?.modifiedCount > 0;
      } catch {
        // Best-effort — if mark fails, skip emit to avoid double-fire
      }
      if (marked) {
        alertCrossed = '80';
        if (billingEvents) {
          billingEvents.emit('meter.threshold_crossed', {
            organizationId,
            weekKey,
            threshold: 80,
            meterUsed: newMeterUsed,
            meterQuota: effectiveQuota,
          });
        }
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
