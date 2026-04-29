/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import config from '../../../config/index.js';
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';
import ProcessedStripeEventRepository from '../repositories/billing.processedStripeEvent.repository.js';
import BillingExtraService from './billing.extra.service.js';
import BillingResetService from './billing.reset.service.js';
import billingEvents from '../lib/events.js';

const Organization = mongoose.model('Organization');

/**
 * Valid plan names from config (immutable set for O(1) lookups).
 */
const validPlans = new Set(config.billing?.plans || ['free', 'starter', 'pro', 'enterprise']);

/**
 * @desc Validate that a plan name is a known enum value.
 * @param {string} plan - The plan name to validate.
 * @returns {string|null} The plan name if valid, null otherwise.
 */
const validatePlan = (plan) => (validPlans.has(plan) ? plan : null);

/**
 * Plan rank lookup — higher index means higher-tier plan.
 * Used to determine upgrade vs downgrade.
 */
const planRanks = Object.fromEntries((config.billing?.plans || []).map((p, i) => [p, i]));

/**
 * @desc Resolve the plan name from a Stripe subscription object.
 * In webhook payloads, price.product is typically a string ID (not expanded),
 * so we check price.metadata first, then fall back to plan.metadata.
 * @param {Object} subscription - Stripe subscription object
 * @returns {string} plan name
 */
const resolvePlan = (subscription) => {
  const item = subscription.items?.data?.[0];
  const raw = item?.price?.metadata?.planId || item?.plan?.metadata?.planId;
  return validatePlan(raw) || 'free';
};

/**
 * @desc Sync the organization plan field to match the subscription plan
 * @param {String} organizationId - Organization document ID
 * @param {String} plan - Plan name to set
 * @returns {Promise<void>}
 */
const syncOrganizationPlan = async (organizationId, plan) => {
  if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) return;
  await Organization.findByIdAndUpdate(organizationId, { plan }, { runValidators: true }).exec();
};

/**
 * @desc Wrap a webhook handler with idempotency using ProcessedStripeEvent.
 *       If the event has already been processed, returns { skipped: true, reason: 'duplicate_event' }.
 *       Otherwise records the event and delegates to handler(event).
 *       Handler receives the full Stripe event object.
 * @param {Object} event - Full Stripe event object (must have event.id and event.type).
 * @param {Function} handler - Async function (event) => result called when event is new.
 * @returns {Promise<Object>} Handler result or skip sentinel.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const withIdempotency = async (event, handler) => {
  const { recorded } = await ProcessedStripeEventRepository.tryRecord(event.id, event.type);
  if (!recorded) return { skipped: true, reason: 'duplicate_event' };
  return handler(event);
};

/**
 * @desc Handle checkout.session.completed event — route by session.mode.
 *       mode='subscription' → handleCheckoutCompleted (plan subscription activation).
 *       mode='payment'      → handleCheckoutPaymentCompleted (extras pack credit).
 * @param {Object} event - Full Stripe event (data.object is the session)
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleCheckoutSessionCompleted = async (event) => {
  const session = event.data.object;
  if (session.mode === 'payment') {
    return handleCheckoutPaymentCompleted(session);
  }
  return handleCheckoutCompleted(session);
};

/**
 * @desc Handle checkout.session.completed for mode='subscription' — create or update subscription
 * @param {Object} session - Stripe checkout session object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleCheckoutCompleted = async (session) => {
  const { customer: stripeCustomerId, subscription: stripeSubscriptionId, metadata } = session;
  let organizationId = metadata?.organizationId;
  const plan = validatePlan(metadata?.plan) || 'free';

  // Fallback: resolve organizationId from stripeCustomerId if metadata is missing
  if (!organizationId) {
    const sub = await SubscriptionRepository.findByStripeCustomerId(stripeCustomerId);
    if (sub) organizationId = String(sub.organization?._id || sub.organization);
  }

  if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) return;

  const existing = await SubscriptionRepository.findByOrganization(organizationId);
  if (existing) {
    await SubscriptionRepository.update({
      _id: existing._id,
      stripeCustomerId,
      stripeSubscriptionId,
      plan,
      status: 'active',
    });
  } else {
    await SubscriptionRepository.create({
      organization: organizationId,
      stripeCustomerId,
      stripeSubscriptionId,
      plan,
      status: 'active',
    });
  }

  await syncOrganizationPlan(organizationId, plan);
};

/**
 * @desc Handle checkout.session.completed for mode='payment' — credit extras pack.
 *       Extracts organizationId, packId, kind from session metadata.
 *       Skips silently if kind !== 'extras' or metadata is incomplete.
 * @param {Object} session - Stripe checkout session object (mode='payment')
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleCheckoutPaymentCompleted = async (session) => {
  const { metadata, id: stripeSessionId } = session;
  const { organizationId, packId, kind } = metadata ?? {};

  if (kind !== 'extras') return;
  if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) return;
  if (!packId) return;

  await BillingExtraService.creditPack(organizationId, packId, stripeSessionId);
};

/**
 * @desc Handle customer.subscription.updated event — sync subscription state.
 *       Also triggers resetWeek when current_period_start changes (billing period renewal).
 * @param {Object} subscription - Stripe subscription object
 * @param {Object} event - Full Stripe event (with data.previous_attributes for plan/period change detection)
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleSubscriptionUpdated = async (subscription, event) => {
  const existing = await SubscriptionRepository.findByStripeSubscriptionId(subscription.id);
  if (!existing) return;

  const newPlan = resolvePlan(subscription);
  const newPeriodStart = subscription.current_period_start
    ? new Date(subscription.current_period_start * 1000)
    : undefined;

  const updatePayload = {
    _id: existing._id,
    plan: newPlan,
    status: subscription.status,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
  if (newPeriodStart) updatePayload.currentPeriodStart = newPeriodStart;

  await SubscriptionRepository.update(updatePayload);

  const organizationId = String(existing.organization?._id || existing.organization);
  await syncOrganizationPlan(organizationId, newPlan);

  // Detect plan change from previous_attributes and emit event
  const previousItems = event?.data?.previous_attributes?.items?.data;
  if (previousItems) {
    const previousPlan = previousItems[0]?.price?.metadata?.planId
      || previousItems[0]?.plan?.metadata?.planId
      || null;
    if (previousPlan && previousPlan !== newPlan) {
      const prevRank = planRanks[previousPlan];
      const newRank = planRanks[newPlan];
      const isDowngrade = prevRank != null && newRank != null ? prevRank > newRank : null;
      try {
        billingEvents.emit('plan.changed', {
          organizationId,
          previousPlan,
          newPlan,
          subscription,
          isDowngrade,
        });
      } catch { /* listener errors must not disrupt webhook processing */ }
    }
  }

  // Detect period start change — trigger weekly meter reset
  const previousPeriodStart = event?.data?.previous_attributes?.current_period_start;
  if (
    previousPeriodStart !== undefined &&
    subscription.current_period_start !== previousPeriodStart &&
    newPeriodStart
  ) {
    try {
      await BillingResetService.resetWeek(organizationId, newPeriodStart);
    } catch { /* reset errors must not disrupt webhook processing */ }
  }
};

/**
 * @desc Handle customer.subscription.deleted event — cancel subscription
 * @param {Object} subscription - Stripe subscription object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleSubscriptionDeleted = async (subscription) => {
  const existing = await SubscriptionRepository.findByStripeSubscriptionId(subscription.id);
  if (!existing) return;

  await SubscriptionRepository.update({
    _id: existing._id,
    plan: 'free',
    status: 'canceled',
  });

  await syncOrganizationPlan(existing.organization?._id || existing.organization, 'free');
};

/**
 * @desc Handle invoice.payment_failed event — mark subscription as past_due
 * @param {Object} invoice - Stripe invoice object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleInvoicePaymentFailed = async (invoice) => {
  const { subscription: stripeSubscriptionId } = invoice;
  if (!stripeSubscriptionId) return;

  const existing = await SubscriptionRepository.findByStripeSubscriptionId(stripeSubscriptionId);
  if (!existing) return;

  await SubscriptionRepository.update({
    _id: existing._id,
    status: 'past_due',
  });
};

/**
 * @desc Handle invoice.payment_succeeded event — clear degraded mode (pastDueSince).
 *       When a past-due invoice is finally paid, remove the pastDueSince marker so
 *       the subscription exits degraded mode on next request.
 * @param {Object} invoice - Stripe invoice object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleInvoicePaymentSucceeded = async (invoice) => {
  const { subscription: stripeSubscriptionId } = invoice;
  if (!stripeSubscriptionId) return;

  const existing = await SubscriptionRepository.findByStripeSubscriptionId(stripeSubscriptionId);
  if (!existing) return;

  // Only clear if currently past_due (avoid unnecessary writes on routine invoices)
  if (existing.pastDueSince !== null && existing.pastDueSince !== undefined) {
    await SubscriptionRepository.update({
      _id: existing._id,
      pastDueSince: null,
      status: 'active',
    });
  }
};

/**
 * @desc Handle charge.refunded event — debit ledger proportionally.
 *       The organizationId and stripeSessionId are expected in charge.metadata
 *       (Stripe propagates checkout session metadata to the charge automatically).
 *       Calls BillingExtraService.refundPartial which computes refundUnits from
 *       the original topup entry and config.billing.packs.
 *       Skips if metadata is incomplete or amount_refunded is zero.
 * @param {Object} charge - Stripe charge object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleChargeRefunded = async (charge) => {
  const { amount_refunded: amountRefunded, metadata } = charge;

  // The session ID and organizationId must have been stamped on charge metadata
  // via checkout.session.completed (Stripe propagates session metadata to the charge).
  const { organizationId, stripeSessionId } = metadata ?? {};

  if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) return;
  if (!stripeSessionId) return;
  if (!amountRefunded || amountRefunded <= 0) return;

  // Service layer computes proportional refundUnits from config.billing.packs.
  await BillingExtraService.refundPartial(organizationId, stripeSessionId, amountRefunded);
};

export default {
  withIdempotency,
  handleCheckoutSessionCompleted,
  handleCheckoutCompleted,
  handleCheckoutPaymentCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentFailed,
  handleInvoicePaymentSucceeded,
  handleChargeRefunded,
};
