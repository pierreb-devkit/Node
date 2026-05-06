/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import config from '../../../config/index.js';
import getStripe from '../lib/stripe.js';
import logger from '../../../lib/services/logger.js';
import billingEvents from '../lib/events.js';

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
  const Subscription = mongoose.model('Subscription');
  return Subscription.find(
    { status: { $in: RECONCILE_STATUSES }, stripeSubscriptionId: { $ne: null } },
    { _id: 1, organization: 1, stripeSubscriptionId: 1, stripeCustomerId: 1, plan: 1, status: 1 },
  )
    .skip(page * limit)
    .limit(limit)
    .lean()
    .exec();
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

  if (!statusMismatch && !planMismatch) return { diverged: false };

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
