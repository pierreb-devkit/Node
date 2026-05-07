/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import getStripe from '../lib/stripe.js';
import logger from '../../../lib/services/logger.js';
import billingEvents from '../lib/events.js';
import { currentWeekKey, weekStartDate } from '../lib/billing.isoWeek.js';

/**
 * Page size for the reconciliation cursor — fetch in batches to avoid long-running queries.
 */
const RECONCILE_PAGE_SIZE = 100;

/**
 * Statuses reconciled against Stripe.
 */
const RECONCILE_STATUSES = ['active', 'past_due', 'trialing', 'unpaid'];

/**
 * Valid plan names from config.
 */
const validPlans = new Set(config.billing?.plans || ['free', 'starter', 'pro', 'enterprise']);

/**
 * @function resolveStripePlan
 * @description Resolve the plan name from a Stripe subscription object.
 * @param {Object} subscription - Stripe subscription object.
 * @returns {string} plan name.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const resolveStripePlan = (subscription) => {
  const item = subscription.items?.data?.[0];
  const raw = item?.price?.metadata?.planId || item?.plan?.metadata?.planId;
  return validPlans.has(raw) ? raw : 'free';
};

/**
 * @function runReconciliation
 * @description Paginate all active|past_due|trialing subscriptions, fetch live Stripe status for each,
 *              and emit billing.reconciliation.divergence when status or plan diverges.
 *
 *              LOG-ONLY policy: this function NEVER writes to the DB or Stripe.
 *              Auto-fix is prohibited — it would mask bugs silently.
 *              Ops must use /api/admin/billing/sync or /api/admin/billing/cancel to resolve.
 *
 * @returns {Promise<{checked: number, divergences: number, errors: number}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const runReconciliation = async () => {
  if (!config?.billing?.meterMode) {
    logger.info('[billing.reconcile] meterMode disabled — skipping reconciliation');
    return { checked: 0, divergences: 0, errors: 0 };
  }

  const stripe = getStripe();
  if (!stripe) {
    logger.error('[billing.reconcile] Stripe not configured — cannot reconcile');
    return { checked: 0, divergences: 0, errors: 0 };
  }

  // Lazy import — deferred to keep unit tests importable before model registration.
  const { default: SubscriptionRepository } = await import('../repositories/billing.subscription.repository.js');

  let checked = 0;
  let divergences = 0;
  let errors = 0;
  let lastSeenId = null;

  let hasMore = true;
  while (hasMore) {
    // Cursor-based pagination via _id > lastSeen — stable across new subscriptions inserted
    // mid-run (skip+limit would shift offsets and silently skip or double-process docs).
    const subs = await _fetchPage(SubscriptionRepository, lastSeenId, RECONCILE_PAGE_SIZE);
    if (!subs || subs.length === 0) break;

    for (const sub of subs) {
      try {
        const result = await _reconcileOne(stripe, sub);
        checked += 1;
        if (result.diverged) divergences += 1;
      } catch (err) {
        errors += 1;
        logger.error('[billing.reconcile] error reconciling subscription', {
          subscriptionId: String(sub._id),
          organizationId: String(sub.organization?._id || sub.organization),
          stripeSubscriptionId: sub.stripeSubscriptionId,
          error: err?.message ?? String(err),
        });
      }
    }

    if (subs.length < RECONCILE_PAGE_SIZE) {
      hasMore = false;
    } else {
      lastSeenId = String(subs[subs.length - 1]._id);
    }
  }

  logger.info('[billing.reconcile] reconciliation complete', { checked, divergences, errors });
  return { checked, divergences, errors };
};

/**
 * Fetch one page of active|past_due subscriptions using cursor-based pagination.
 * Passing lastSeenId advances the cursor to the next page; null fetches the first page.
 * Cursor approach is stable across new subscription inserts during a reconcile run —
 * skip+limit would shift offsets and silently skip or double-process documents.
 * @param {Object} SubscriptionRepository - Subscription repository.
 * @param {string|null} lastSeenId - ObjectId string of the last document from the previous page, or null for first page.
 * @param {number} limit - Page size.
 * @returns {Promise<Array>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const _fetchPage = async (SubscriptionRepository, lastSeenId, limit) => {
  return SubscriptionRepository.findPageForReconciliation(
    RECONCILE_STATUSES,
    lastSeenId,
    limit,
  );
};

/**
 * Compute meter↔extras divergence for a single org.
 * Returns { diverged: boolean, expectedExtrasUsage: number, actualExtrasDebits: number }.
 *
 * Strategy:
 *   Both sides use the same ISO week window (currentWeekKey boundaries):
 *   expectedExtrasUsage = units consumed beyond quota in the current week (overflow).
 *   actualExtrasDebits  = absolute sum of debit ledger entries within the current week.
 *
 * Alignment note: using the same ISO week window avoids the cross-window
 * mismatch between billing-period debits and weekly meter overflow.
 *
 * Tolerance: divergence is only reported when
 *   |expected - actual| > max(50, 0.5% × max(expected, actual))
 * This avoids noise from timing skew (usage write before debit commits).
 *
 * @param {string} orgId
 * @returns {Promise<{diverged: boolean, expectedExtrasUsage: number, actualExtrasDebits: number}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const _checkMeterExtrasMismatch = async (orgId) => {
  // Lazy imports — deferred to keep unit tests importable before model registration.
  const { default: BillingUsageRepository } = await import('../repositories/billing.usage.repository.js');
  const { default: BillingExtraBalanceRepository } = await import('../repositories/billing.extraBalance.repository.js');

  const weekKey = currentWeekKey();

  // expectedExtrasUsage: units consumed beyond quota in current week (from BillingUsage doc).
  const usageDoc = await BillingUsageRepository.findByWeek(orgId, weekKey);

  const meterUsed = usageDoc?.meterUsed ?? 0;
  const meterQuota = usageDoc?.meterQuota ?? 0;
  // meterQuota=0 means free plan — every unit is extras.
  const expectedExtrasUsage = meterQuota === 0 ? meterUsed : Math.max(0, meterUsed - meterQuota);

  // actualExtrasDebits: server-side aggregated sum of debit entries in the same ISO week.
  // Both sides share the same week boundary — apples-to-apples comparison (CodeRabbit fix).
  const weekStart = weekStartDate(weekKey);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000); // exclusive upper bound

  const actualExtrasDebits = await BillingExtraBalanceRepository.sumDebitsByWindow(
    orgId,
    weekStart,
    weekEnd,
  );

  // Tolerance: abs(delta) > max(50, 0.5% × max(expected, actual)) triggers divergence.
  const delta = Math.abs(expectedExtrasUsage - actualExtrasDebits);
  const toleranceBasis = Math.max(expectedExtrasUsage, actualExtrasDebits);
  const tolerance = Math.max(50, 0.005 * toleranceBasis);

  if (delta <= tolerance) return { diverged: false, expectedExtrasUsage, actualExtrasDebits };

  return { diverged: true, expectedExtrasUsage, actualExtrasDebits };
};

/**
 * Reconcile a single subscription against Stripe.
 * Returns { diverged: boolean }.
 * @param {Object} stripe - Stripe client.
 * @param {Object} sub - DB subscription (lean).
 * @returns {Promise<{diverged: boolean}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const _reconcileOne = async (stripe, sub) => {
  const orgId = String(sub.organization?._id || sub.organization);
  const subId = sub.stripeSubscriptionId;

  const stripeSub = await stripe.subscriptions.retrieve(subId);
  const stripeStatus = stripeSub.status;
  const stripePlan = resolveStripePlan(stripeSub);

  const statusMismatch = sub.status !== stripeStatus;
  const planMismatch = sub.plan !== stripePlan;

  // Check meter↔extras divergence for this org (Opus C1 detection layer).
  // This runs regardless of status/plan match — a healthy subscription can still
  // have an accumulating ledger mismatch if debits were silently dropped.
  let meterExtrasMismatch = false;
  try {
    const mismatchResult = await _checkMeterExtrasMismatch(orgId);
    meterExtrasMismatch = mismatchResult.diverged;

    if (meterExtrasMismatch) {
      const mismatchPayload = {
        organizationId: orgId,
        subscriptionId: String(sub._id),
        subType: 'meter_extras_mismatch',
        expectedExtrasUsage: mismatchResult.expectedExtrasUsage,
        actualExtrasDebits: mismatchResult.actualExtrasDebits,
        delta: Math.abs(mismatchResult.expectedExtrasUsage - mismatchResult.actualExtrasDebits),
      };
      logger.error('[billing.reconcile] meter↔extras mismatch detected — LOG ONLY, no auto-fix', mismatchPayload);
      try {
        billingEvents.emit('billing.reconciliation.divergence', mismatchPayload);
      } catch (evtErr) {
        logger.error('[billing.reconcile] billing.reconciliation.divergence (meter_extras_mismatch) listener error (non-fatal)', {
          error: evtErr?.message ?? String(evtErr),
        });
      }
    }
  } catch (mismatchErr) {
    // Non-fatal: meter↔extras check failure does not block the Stripe status/plan check.
    logger.error('[billing.reconcile] meter↔extras check failed (non-fatal)', {
      organizationId: orgId,
      error: mismatchErr?.message ?? String(mismatchErr),
    });
  }

  if (!statusMismatch && !planMismatch) return { diverged: meterExtrasMismatch };

  const payload = {
    organizationId: orgId,
    subscriptionId: String(sub._id),
    stripeSubscriptionId: subId,
    db: { status: sub.status, plan: sub.plan },
    stripe: { status: stripeStatus, plan: stripePlan },
    statusMismatch,
    planMismatch,
  };

  // Critical: status divergence may indicate billing bypass or stale webhook delivery.
  logger.error('[billing.reconcile] divergence detected — LOG ONLY, no auto-fix', payload);

  try {
    billingEvents.emit('billing.reconciliation.divergence', payload);
  } catch (evtErr) {
    logger.error('[billing.reconcile] billing.reconciliation.divergence listener error (non-fatal)', {
      error: evtErr?.message ?? String(evtErr),
    });
  }

  return { diverged: true };
};

export default {
  runReconciliation,
};
