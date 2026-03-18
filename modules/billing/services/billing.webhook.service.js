/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import config from '../../../config/index.js';
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';
import billingEvents from '../lib/events.js';

const Organization = mongoose.model('Organization');

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
  return item?.price?.metadata?.planId || item?.plan?.metadata?.planId || 'free';
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
 * @desc Handle checkout.session.completed event — create or update subscription
 * @param {Object} session - Stripe checkout session object
 * @returns {Promise<void>}
 */
const handleCheckoutCompleted = async (session) => {
  const { customer: stripeCustomerId, subscription: stripeSubscriptionId, metadata } = session;
  let organizationId = metadata?.organizationId;
  const plan = metadata?.plan || 'free';

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
 * @desc Handle customer.subscription.updated event — sync subscription state
 * @param {Object} subscription - Stripe subscription object
 * @param {Object} event - Full Stripe event (with data.previous_attributes for plan change detection)
 * @returns {Promise<void>}
 */
const handleSubscriptionUpdated = async (subscription, event) => {
  const existing = await SubscriptionRepository.findByStripeSubscriptionId(subscription.id);
  if (!existing) return;

  const newPlan = resolvePlan(subscription);
  await SubscriptionRepository.update({
    _id: existing._id,
    plan: newPlan,
    status: subscription.status,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });

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
};

/**
 * @desc Handle customer.subscription.deleted event — cancel subscription
 * @param {Object} subscription - Stripe subscription object
 * @returns {Promise<void>}
 */
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

export default {
  handleCheckoutCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentFailed,
};
