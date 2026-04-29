/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import BillingUsageRepository from '../repositories/billing.usage.repository.js';
import BillingSubscriptionRepository from '../repositories/billing.subscription.repository.js';
import BillingPlanService from './billing.plan.service.js';

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
 *              incrementMeter uses $ne on consumedHistoryIds so a duplicate upsert
 *              will hit the 11000 path in incrementMeter's retry branch.
 *
 * @param {string} orgId - The organization ObjectId (string).
 * @param {Date} periodStart - The start of the new billing period (used to derive newWeekKey).
 * @returns {Promise<Object>} The upserted usage document for the new week.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const resetWeek = async (orgId, periodStart) => {
  if (!config?.billing?.meterMode) return null;

  const now = new Date();
  const newWeekKey = isoWeekKey(periodStart);

  // Step 1 — Archive any existing docs for this org that are NOT the new week key.
  // Delegates to repository — no mongoose import in service layer.
  await BillingUsageRepository.archiveOtherWeeks(orgId, newWeekKey, now);

  // Step 2 — Fetch the active plan to snapshot quota/planVersion.
  const planId = config?.billing?.plans?.[0] ?? 'pro';
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
      consumedHistoryIds: [],
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
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Find subscriptions whose period started within the last week.
  // TODO PR-N5: replace window query with lastResetAt field for scheduler-delay resilience.
  const subs = await BillingSubscriptionRepository.findAllDueForReset(oneWeekAgo, now);

  let processed = 0;
  let errors = 0;

  for (const sub of subs) {
    try {
      await resetWeek(String(sub.organizationId), new Date(sub.currentPeriodStart));
      processed += 1;
    } catch (err) {
      errors += 1;
      console.error(`[billing.reset] resetWeek failed for org ${sub.organizationId}:`, err);
    }
  }

  return { processed, errors };
};

export default {
  resetWeek,
  resetAllDue,
  isoWeekKey,
};
