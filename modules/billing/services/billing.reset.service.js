/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import BillingUsageRepository from '../repositories/billing.usage.repository.js';
import BillingSubscriptionRepository from '../repositories/billing.subscription.repository.js';
import BillingPlanService from './billing.plan.service.js';
import billingEvents from '../lib/events.js';

/**
 * Compute the ISO week key (YYYY-Www) for a given date.
 * ISO 8601: week starts on Monday; week 1 contains the first Thursday.
 * @param {Date} date - The date to compute the week key for.
 * @returns {string} The week key in YYYY-Www format (e.g. "2026-W18").
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const isoWeekKey = (date) => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Move to the nearest Thursday (ISO week definition anchor)
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
};

/**
 * @function resetWeek
 * @description Atomic archive-then-upsert pattern for weekly meter reset.
 *              1. Archives the old week document (sets archivedAt = now).
 *              2. Upserts a new week document with snapshot quota/planVersion.
 *              Both operations are idempotent — re-running for the same periodStart
 *              is safe: if the old doc is already archived and the new doc exists,
 *              both operations are no-ops.
 *
 *              Race: if resetWeek and incrementMeter race on the same weekKey,
 *              the unique (organizationId, weekKey) index causes the concurrent upsert
 *              to throw E11000 — handled by incrementMeter's retry branch (non-upsert retry).
 *              (The $ne on consumedAttributionKeys is replay protection within the same doc,
 *              not the race guard.)
 *
 * @param {string} orgId - The organization ObjectId (string).
 * @param {Date} periodStart - The start of the new billing period (used to derive newWeekKey).
 * @returns {Promise<Object|null>} The upserted usage document for the new week, or null when meter mode is off.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const resetWeek = async (orgId, periodStart) => {
  if (!config?.billing?.meterMode) return null;

  const now = new Date();
  const newWeekKey = isoWeekKey(periodStart);

  // Step 1 — Archive any existing docs for this org that are NOT the new week key.
  // Delegates to repository — no mongoose import in service layer.
  await BillingUsageRepository.archiveOtherWeeks(orgId, newWeekKey, now);

  // Step 2 — Fetch the active plan to snapshot quota/planVersion — lean projection (plan only, no populate).
  const subscription = await BillingSubscriptionRepository.findPlan(orgId);
  const planId = subscription?.plan ?? config?.billing?.defaultPlan ?? 'free';
  const activePlan = await BillingPlanService.getActivePlan(planId);
  const meterQuota = activePlan?.meterQuota ?? 0;
  const planVersion = activePlan?.version ?? null;

  // Compute resetAt = start of next week (7 days after periodStart)
  const resetAt = new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Month key for the new week (YYYY-MM of periodStart)
  const monthKey = `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;

  // Step 3 — Upsert the new week document with snapshot fields.
  const newDoc = await BillingUsageRepository.findByWeek(orgId, newWeekKey);
  if (newDoc) return newDoc; // Already exists — idempotent

  try {
    return await BillingUsageRepository.upsertWeekSnapshot(orgId, newWeekKey, {
      organizationId: orgId,
      weekKey: newWeekKey,
      month: monthKey,
      meterUsed: 0,
      meterQuota,
      planVersion,
      meterBreakdown: {},
      resetAt,
      alertedAt80: null,
      alertedAt100: null,
      consumedAttributionKeys: [],
    });
  } catch (err) {
    if (err.code === 11000) {
      // Race: another pod already created this week's doc
      return BillingUsageRepository.findByWeek(orgId, newWeekKey);
    }
    throw err;
  }
};

/**
 * @function forceRotateForPlanChange
 * @description Refresh the current week's quota/planVersion snapshot after a
 *              Stripe plan change. Unlike resetWeek, this does not archive or
 *              upsert weekly documents: if the current week doc does not exist,
 *              the next attribution lazily creates it with the active plan.
 * @param {string} organizationId - The organization ObjectId (string).
 * @param {Object} [options={}] - Rotation options.
 * @param {boolean} [options.preserveUsage=true] - Keep meterUsed and breakdown when true; reset them when false.
 * @returns {Promise<Object|null>} The updated current week usage document, or null when no current doc exists.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const forceRotateForPlanChange = async (organizationId, options = {}) => {
  if (!config?.billing?.meterMode) return null;

  const { preserveUsage = true } = options ?? {};
  const now = new Date();
  const currentWeekKey = isoWeekKey(now);
  const existingDoc = await BillingUsageRepository.findByWeek(organizationId, currentWeekKey);
  if (!existingDoc) return null;

  const subscription = await BillingSubscriptionRepository.findPlan(organizationId);
  const planId = subscription?.plan ?? config?.billing?.defaultPlan ?? 'free';
  const activePlan = await BillingPlanService.getActivePlan(planId);
  const newQuota = activePlan?.meterQuota ?? 0;
  const newVersion = activePlan?.version ?? null;
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const updatedDoc = await BillingUsageRepository.rotateWeekSnapshotForPlanChange(
    organizationId,
    currentWeekKey,
    {
      meterQuota: newQuota,
      planVersion: newVersion,
      month,
    },
    preserveUsage,
  );

  try {
    billingEvents.emit('billing.plan_change.rotated', {
      organizationId,
      oldQuota: existingDoc.meterQuota ?? 0,
      newQuota,
      oldVersion: existingDoc.planVersion ?? null,
      newVersion,
      preserveUsage,
    });
  } catch (evtErr) {
    // Listener errors must not disrupt plan-change rotation — log for traceability
    console.error('[billing.reset] billing.plan_change.rotated listener error (non-fatal):', evtErr?.message ?? evtErr);
  }

  return updatedDoc;
};

/**
 * @function resetAllDue
 * @description Iterate active subscriptions where current_period_start has crossed
 *              a weekly boundary and call resetWeek for each.
 *              Only runs when meterMode is enabled.
 *
 * @returns {Promise<{processed: number, errors: number}>} Summary of the sweep.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const resetAllDue = async () => {
  if (!config?.billing?.meterMode) return { processed: 0, errors: 0 };

  const now = new Date();
  const subs = await BillingSubscriptionRepository.findAllDueForResetByLastReset(now);

  let processed = 0;
  let errors = 0;

  for (const sub of subs) {
    try {
      // Derive the week anchor from lastResetAt + 7d (or now when no prior reset exists).
      // Using currentPeriodStart would derive the same weekKey every run within the same
      // monthly/annual Stripe cycle → reset would be a no-op for weeks 2/3/4.
      // Clamp to now: if cron is delayed >1 week the natural anchor (lastResetAt+7d) is in
      // the past → stale ISO week bucket. max(lastResetAt+7d, now) ensures we always write
      // the current week when the cron runs late (idempotent on duplicate late runs).
      const anchor = sub.lastResetAt
        ? new Date(Math.max(new Date(sub.lastResetAt).getTime() + 7 * 24 * 60 * 60 * 1000, now.getTime()))
        : now;
      await resetWeek(String(sub.organization), anchor);
      await BillingSubscriptionRepository.updateLastResetAt(String(sub.organization), now);
      processed += 1;
    } catch (err) {
      errors += 1;
      console.error(`[billing.reset] resetWeek failed for org ${sub.organization}:`, err);
    }
  }

  return { processed, errors };
};

export default {
  resetWeek,
  forceRotateForPlanChange,
  resetAllDue,
  isoWeekKey,
};
