/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import getStripe from '../lib/stripe.js';
import logger from '../../../lib/services/logger.js';
import billingEvents from '../lib/events.js';
import { currentWeekKey } from '../lib/billing.isoWeek.js';

/**
 * Page size for the reconciliation cursor — fetch in batches to avoid long-running queries.
 */
const RECONCILE_PAGE_SIZE = 100;

/**
 * Statuses reconciled against Stripe.
 */
const RECONCILE_STATUSES = ['active', 'past_due'];

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
 * @description Paginate all active|past_due subscriptions, fetch live Stripe status for each,
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
  let page = 0;

  let hasMore = true;
  while (hasMore) {
    // Paginate via skip+limit — for large collections consider cursor-based pagination,
    // but skip is acceptable for ops crons running at low frequency.
    const subs = await _fetchPage(SubscriptionRepository, page, RECONCILE_PAGE_SIZE);
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
      page += 1;
    }
  }

  logger.info('[billing.reconcile] reconciliation complete', { checked, divergences, errors });
  return { checked, divergences, errors };
};

/**
 * Fetch one page of active|past_due subscriptions.
 * @param {Object} SubscriptionRepository - Subscription repository.
 * @param {number} page - 0-based page index.
 * @param {number} limit - Page size.
 * @returns {Promise<Array>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const _fetchPage = async (SubscriptionRepository, page, limit) => {
  return SubscriptionRepository.findPageForReconciliation(
    RECONCILE_STATUSES,
    page,
    limit,
  );
};

/**
 * Compute meter↔extras divergence for a single org.
 * Returns { diverged: boolean, expectedExtrasUsage: number, actualExtrasDebits: number }.
 *
 * Strategy:
 *   expectedExtrasUsage = units consumed beyond quota in the current week (overflow).
 *   actualExtrasDebits  = absolute sum of ledger debit entries recorded since the
 *                         current period started (cachedBalance change due to debits only).
 *
 * Tolerance: divergence is only reported when
 *   |expected - actual| > max(50, 0.5% × max(expected, actual))
 * This avoids noise from timing skew (usage write before debit commits).
 *
 * @param {string} orgId
 * @param {Object} sub - DB subscription (lean) — provides currentPeriodStart.
 * @returns {Promise<{diverged: boolean, expectedExtrasUsage: number, actualExtrasDebits: number}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const _checkMeterExtrasMismatch = async (orgId, sub) => {
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

  // actualExtrasDebits: absolute sum of debit ledger entries since current period started.
  // Use currentPeriodStart from the DB subscription as period boundary, falling back to
  // the start of the current week if not set.
  const periodStart = sub.currentPeriodStart ? new Date(sub.currentPeriodStart) : null;

  const ledger = await BillingExtraBalanceRepository.findLedgerByOrg(orgId);
  const extraDoc = ledger ? { ledger } : null;

  let actualExtrasDebits = 0;
  if (extraDoc?.ledger) {
    for (const entry of extraDoc.ledger) {
      if (entry.kind !== 'debit') continue;
      if (periodStart && entry.at && new Date(entry.at) < periodStart) continue;
      // Debit entries have negative amount; sum their absolute values.
      actualExtrasDebits += Math.abs(entry.amount);
    }
  }

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
    const mismatchResult = await _checkMeterExtrasMismatch(orgId, sub);
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
