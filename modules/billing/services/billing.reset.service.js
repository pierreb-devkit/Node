/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';
import BillingUsageRepository from '../repositories/billing.usage.repository.js';
import BillingSubscriptionRepository from '../repositories/billing.subscription.repository.js';
import BillingExtraBalanceRepository from '../repositories/billing.extraBalance.repository.js';
import BillingPlanService from './billing.plan.service.js';
import billingEvents from '../lib/events.js';
import { isoWeekKey } from '../lib/billing.isoWeek.js';
import { getPlanChangePreserveUsageDefault, getDefaultPlanId } from '../lib/billing.constants.js';
import { isDuplicateKeyError } from '../lib/billing.errors.js';

/**
 * @function computeOverflowSettlement
 * @description Units of overflow debt to repay from the new week's quota.
 *              Refund and expiration debt is excluded: it is never settled from quota.
 * @param {string} orgId - The organization ObjectId (string).
 * @param {number} meterQuota - The new week's plan quota.
 * @returns {Promise<number>} Units to settle, in [0, meterQuota].
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const computeOverflowSettlement = async (orgId, meterQuota) => {
  if (!(meterQuota > 0)) return 0;
  const { cachedBalance, nonSettleableDebt } = await BillingExtraBalanceRepository.getSettlementBasis(orgId);
  return Math.max(0, Math.min(meterQuota, -cachedBalance - nonSettleableDebt));
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
 *              Overflow-debt settlement (plans with meterQuota > 0 only): units consumed
 *              past the quota are debited from extras, which may go negative. Without a
 *              settlement that debt would shrink every later week by the same amount.
 *              Up to one week of quota repays it:
 *                settle = max(0, min(meterQuota, -cachedBalance - nonSettleableDebt))
 *              Order, each step idempotent so any race or retry converges:
 *                a. Credit extras `settle` through an 'adjustment' entry with refId
 *                   `settle:<weekKey>` (shared across pods/retries — lands at most once).
 *                   A thrown credit is logged; nothing is charged to the week.
 *                b. Insert the week doc with meterUsed = 0 (or reuse the one another reset
 *                   or incrementMeter already created).
 *                c. Read the `settle:<weekKey>` entry actually stored in the ledger and, if
 *                   present, charge its amount to the week with ONE guarded update
 *                   ($inc meterUsed, key `settle:<weekKey>` pushed into
 *                   consumedAttributionKeys, filtered on the key being absent).
 *              Step c runs on every call, so a reset that credited then failed before
 *              charging the week is completed by the next call for that week; the key guard
 *              makes the charge land exactly once, whichever call wins.
 *              Refund and expiration debt counts only the unpaid part of refunds and pack
 *              expirations (see getSettlementBasis) — it is never settled; only a new pack
 *              repays it.
 *              Plans with meterQuota 0 are untouched: a pack repays the debt.
 *
 * @param {string} orgId - The organization ObjectId (string).
 * @param {Date} periodStart - The start of the new billing period (used to derive newWeekKey).
 * @returns {Promise<Object|null>} The usage document for the new week, or null when meter mode is off.
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
  const planId = subscription?.plan ?? getDefaultPlanId();
  const activePlan = BillingPlanService.getActivePlan(planId);
  const meterQuota = activePlan?.meterQuota ?? 0;
  const planVersion = activePlan?.version ?? null;

  // Compute resetAt = start of next week (7 days after periodStart)
  const resetAt = new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Month key for the new week (YYYY-MM of periodStart)
  const monthKey = `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;

  const settlementKey = `settle:${newWeekKey}`;

  // Step 3 — Credit the settled units back to extras (idempotent refId, shared across
  // pods/retries). A thrown error means no credit: log it and never let it abort resetWeek —
  // the week is then charged nothing and the debt survives for the next reset.
  const settle = await computeOverflowSettlement(orgId, meterQuota);
  if (settle > 0) {
    try {
      await BillingExtraBalanceRepository.creditCompensation(orgId, settle, settlementKey, 'weekly overflow debt settlement');
    } catch (err) {
      logger.error('[billing.reset] overflow debt settlement credit failed before week insert', {
        orgId,
        weekKey: newWeekKey,
        settle,
        err: err?.message ?? String(err),
      });
    }
  }

  // Step 4 — Obtain the week document, inserted with meterUsed = 0 when it does not exist yet.
  let weekDoc = await BillingUsageRepository.findByWeek(orgId, newWeekKey);
  if (!weekDoc) {
    try {
      const upserted = await BillingUsageRepository.upsertWeekSnapshot(orgId, newWeekKey, {
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
      weekDoc = upserted.doc;
    } catch (err) {
      // Race: another reset or incrementMeter created the doc first — settle on it all the same.
      if (!isDuplicateKeyError(err)) throw err;
      weekDoc = await BillingUsageRepository.findByWeek(orgId, newWeekKey);
    }
  }

  // Step 5 — Charge the week with the credit actually stored (not the recomputed `settle`,
  // which drops once the credit lands), exactly once thanks to the key guard.
  const credit = await BillingExtraBalanceRepository.findLedgerEntryByRefId(orgId, settlementKey);
  if (credit?.kind === 'adjustment' && credit.amount > 0) {
    const charged = await BillingUsageRepository.applySettlementUsage(orgId, newWeekKey, credit.amount, settlementKey);
    if (charged) return charged;
  }

  return weekDoc;
};

/**
 * @function forceRotateForPlanChange
 * @description Refresh the current week's quota/planVersion snapshot after a
 *              Stripe plan change. Unlike resetWeek, this does not archive or
 *              upsert weekly documents: if the current week doc does not exist,
 *              the next attribution lazily creates it with the active plan.
 * @param {string} organizationId - The organization ObjectId (string).
 * @param {Object} [options={}] - Rotation options.
 * @param {boolean} [options.preserveUsage] - Keep meterUsed and breakdown when true; defaults to config billing.planChange.preserveUsageDefault.
 * @returns {Promise<Object|null>} The updated current week usage document, or null when no current doc exists.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const forceRotateForPlanChange = async (organizationId, options = {}) => {
  if (!config?.billing?.meterMode) return null;

  const { preserveUsage = getPlanChangePreserveUsageDefault() } = options ?? {};
  const now = new Date();
  const currentWeekKey = isoWeekKey(now);
  const existingDoc = await BillingUsageRepository.findByWeek(organizationId, currentWeekKey);
  if (!existingDoc) return null;

  const subscription = await BillingSubscriptionRepository.findPlan(organizationId);
  const planId = subscription?.plan ?? getDefaultPlanId();
  const activePlan = BillingPlanService.getActivePlan(planId);
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
};
