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
 * @description Validate that a plan name is a known enum value.
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
 * @description Resolve the plan name from a Stripe subscription object.
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
 * @description Sync the organization plan field to match the subscription plan
 * @param {String} organizationId - Organization document ID
 * @param {String} plan - Plan name to set
 * @returns {Promise<void>}
 */
const syncOrganizationPlan = async (organizationId, plan) => {
  if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) return;
  await Organization.findByIdAndUpdate(organizationId, { plan }, { runValidators: true }).exec();
};

/**
 * @description Wrap a webhook handler with idempotency using ProcessedStripeEvent.
 *
 * Semantics:
 * - Pre-check via wasProcessed: short-circuits Stripe retries of identical events that already
 *   completed — handler is not invoked again.
 * - Record AFTER handler: if handler throws, the event remains "not processed" so Stripe can
 *   retry and the handler can eventually succeed. Prevents silent loss.
 * - TOCTOU between wasProcessed and tryRecord: two concurrent Stripe deliveries of the same
 *   event can both pass wasProcessed and both run handler. Acceptable because data-layer
 *   mutations are idempotent (creditPack uses $ne stripeSessionId, refundPartial uses $ne refId,
 *   subscription update is last-write-wins). tryRecord is best-effort dedup after success.
 *
 * @param {Object} event - Full Stripe event object (must have event.id and event.type).
 * @param {Function} handler - Async function (event) => result called when event is new.
 * @returns {Promise<Object>} Handler result or skip sentinel { skipped: true, reason: 'duplicate_event' }.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const withIdempotency = async (event, handler) => {
  // Pre-check: if already processed, skip (Stripe retry of the same event)
  if (await ProcessedStripeEventRepository.wasProcessed(event.id)) {
    return { skipped: true, reason: 'duplicate_event' };
  }
  // Run handler first — data-layer is already idempotent (creditPack, refundPartial, etc.)
  const result = await handler(event);
  // Best-effort dedup hint after success — TOCTOU is acceptable since data-layer guards prevent double-effect
  await ProcessedStripeEventRepository.tryRecord(event.id, event.type);
  return result;
};

/**
 * @description Handle checkout.session.completed event — route by session.mode.
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
 * @description Handle checkout.session.completed for mode='subscription' — create or update subscription
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
 * @description Handle checkout.session.completed for mode='payment' — credit extras pack.
 *       Extracts organizationId, packId, kind from session metadata.
 *       Skips silently if payment_status !== 'paid', kind !== 'extras', or metadata is incomplete.
 * @param {Object} session - Stripe checkout session object (mode='payment')
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleCheckoutPaymentCompleted = async (session) => {
  if (session.payment_status !== 'paid') return;

  const { metadata, id: stripeSessionId } = session;
  const { organizationId, packId, kind } = metadata ?? {};

  if (kind !== 'extras') return;
  if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) return;
  if (!packId) return;

  await BillingExtraService.creditPack(organizationId, packId, stripeSessionId);
};

/**
 * @description Handle customer.subscription.updated event — sync subscription state.
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
    } catch (err) {
      // Log for monitoring — not thrown so webhook processing continues
      console.error('[billing.webhook] resetWeek failed (non-fatal):', err?.message ?? err);
    }
  }
};

/**
 * @description Handle customer.subscription.deleted event — cancel subscription
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
 * @description Handle invoice.payment_failed event — mark subscription as past_due.
 *              Sets pastDueSince = now only when not already set (idempotent: multiple
 *              failed invoices do not reset the grace-period clock).
 *              Emits 'payment.failed' so downstream listeners can react (e.g. notifications).
 * @param {Object} invoice - Stripe invoice object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleInvoicePaymentFailed = async (invoice) => {
  const { subscription: stripeSubscriptionId } = invoice;
  if (!stripeSubscriptionId) return;

  const existing = await SubscriptionRepository.findByStripeSubscriptionId(stripeSubscriptionId);
  if (!existing) return;

  const updatePayload = { _id: existing._id, status: 'past_due' };

  // Only set pastDueSince on first failure — do not reset the grace-period clock on retries.
  if (existing.pastDueSince == null) {
    updatePayload.pastDueSince = new Date();
  }

  await SubscriptionRepository.update(updatePayload);

  const organizationId = String(existing.organization?._id || existing.organization);
  try {
    billingEvents.emit('payment.failed', { organizationId });
  } catch { /* listener errors must not disrupt webhook processing */ }
};

/**
 * @description Handle invoice.payment_succeeded event — clear degraded mode (pastDueSince).
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
 * @description Handle charge.refunded event — debit ledger proportionally.
 *       Reads charge.metadata.{organizationId, stripeSessionId} which must be propagated
 *       via the upstream session creation pattern:
 *         stripe.checkout.sessions.create({
 *           ...,
 *           metadata: { organizationId, stripeSessionId, ... },
 *           payment_intent_data: { metadata: { organizationId, stripeSessionId, ... } },
 *         })
 *       Without payment_intent_data.metadata, charge.metadata will be empty and refunds
 *       silently skip. Downstream (trawl_node) is responsible for setting these at session creation.
 *       Calls BillingExtraService.refundPartial which computes refundUnits from
 *       the original topup entry and config.billing.packs.
 *       Uses charge.refunds.data[0].amount (this event's refund delta) rather than
 *       charge.amount_refunded (cumulative total) to avoid over-debiting on multiple partial refunds.
 *       Skips if metadata is incomplete or the refund amount is zero.
 * @param {Object} charge - Stripe charge object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleChargeRefunded = async (charge) => {
  const { metadata } = charge;

  // The session ID and organizationId must have been stamped on charge metadata
  // via payment_intent_data.metadata at session creation (not automatic — caller must set both
  // session.metadata and payment_intent_data.metadata explicitly).
  const { organizationId, stripeSessionId } = metadata ?? {};

  if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) return;
  if (!stripeSessionId) return;

  // Use this event's refund delta (charge.refunds.data[0].amount), not the cumulative
  // charge.amount_refunded — prevents over-debiting when multiple partial refunds occur.
  const thisRefundAmount = charge.refunds?.data?.[0]?.amount;
  if (!thisRefundAmount || thisRefundAmount <= 0) return;

  // Service layer computes proportional refundUnits from config.billing.packs.
  await BillingExtraService.refundPartial(organizationId, stripeSessionId, thisRefundAmount);
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
