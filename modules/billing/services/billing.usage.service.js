/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import UsageRepository from '../repositories/billing.usage.repository.js';
import BillingSubscriptionRepository from '../repositories/billing.subscription.repository.js';
import BillingMeterOutboxRepository from '../repositories/billing.meter.outbox.repository.js';
import BillingPlanService from './billing.plan.service.js';
import billingEvents from '../lib/events.js';
import { currentWeekKey } from '../lib/billing.isoWeek.js';
import { getAlertThresholdPercents } from '../lib/billing.constants.js';
import { isDuplicateKeyError } from '../lib/billing.errors.js';

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
 *              2. Fetches the active plan snapshot (meterQuota + planVersion).
 *              3. Calls repo.incrementMeter atomically with replay protection.
 *              4. If quota is exceeded, overflows into extras balance.
 *              5. Detects configured threshold crossings (emits meter.threshold_crossed event, once per cycle).
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

  // Threshold detection — emit configured thresholds, deduplicated per cycle
  let alertCrossed = null;

  if (effectiveQuota > 0) {
    const pct = (newMeterUsed / effectiveQuota) * 100;
    for (const threshold of getAlertThresholdPercents()) {
      const field = thresholdFields[threshold];
      if (!field || pct < threshold || updatedDoc[field]) continue;

      let marked = false;
      try {
        const markResult = await UsageRepository.markThreshold(updatedDoc._id, field);
        marked = markResult?.modifiedCount > 0;
      } catch (err) {
        console.warn('[billing.usage] threshold mark failed, skipping emit:', err?.message ?? err);
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
        break;
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
 * @function incrementMeterWithOutbox
 * @description Increment meter usage and, when the increment overflows into
 *              extras, create the pending extras-debit outbox row before
 *              returning to the caller. This keeps usage idempotency and the
 *              reconciliation record coupled on the hot path. If Mongo
 *              transactions are unavailable in the deployment, this is the
 *              immediate-after fallback described by the billing lifecycle docs.
 * @param {string} organizationId - The organization ObjectId (string).
 * @param {number} units - Meter units to attribute.
 * @param {Object} breakdown - Feature-keyed breakdown: { featureKey: units }.
 * @param {string} idempotencyKey - Unique key for replay protection.
 * @returns {Promise<{applied: boolean, meterUsed: number, meterQuota: number, extrasConsumed: number, alertCrossed: string|null, outbox?: Object}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const incrementMeterWithOutbox = async (organizationId, units, breakdown, idempotencyKey) => {
  const result = await incrementMeter(organizationId, units, breakdown, idempotencyKey);
  if (!result.applied || result.extrasConsumed <= 0) return result;

  let outbox;
  try {
    outbox = await BillingMeterOutboxRepository.create({
      organizationId,
      idempotencyKey,
      extrasUnits: result.extrasConsumed,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      outbox = await BillingMeterOutboxRepository.findByIdempotencyKey(idempotencyKey);
      if (!outbox) {
        throw new Error('[billing] outbox state desynced — meter incremented but outbox missing');
      }
    } else {
      console.error('[billing] CRITICAL outbox create failed after meter increment', { idempotencyKey, err });
      const wrapped = new Error(`[billing] outbox create failed after meter increment: ${err?.message ?? err}`);
      wrapped.cause = err;
      throw wrapped;
    }
  }

  return { ...result, outbox };
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
  incrementMeterWithOutbox,
  getMeter,
};
