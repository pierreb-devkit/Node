/**
 * Module dependencies
 */
import Stripe from 'stripe';

import config from '../../../config/index.js';
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';

/**
 * Lazily instantiated Stripe client
 */
let stripeClient = null;

/**
 * @desc Get or create the Stripe client instance
 * @returns {Object|null} Stripe client or null if not configured
 */
const getStripe = () => {
  if (stripeClient) return stripeClient;
  if (!config.stripe?.secretKey) return null;
  stripeClient = new Stripe(config.stripe.secretKey);
  return stripeClient;
};

/**
 * @desc Create a Stripe Checkout Session for the given organization
 * @param {Object} organization - The organization document
 * @param {String} priceId - Stripe price ID
 * @param {String} successUrl - URL to redirect on success
 * @param {String} cancelUrl - URL to redirect on cancel
 * @returns {Promise<String>} Checkout session URL
 */
const createCheckout = async (organization, priceId, successUrl, cancelUrl) => {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured');

  // Find or create subscription record with Stripe customer
  let subscription = await SubscriptionRepository.findByOrganization(organization._id);

  if (!subscription?.stripeCustomerId) {
    const customer = await stripe.customers.create({
      name: organization.name,
      metadata: { organizationId: String(organization._id) },
    });

    if (subscription) {
      subscription = await SubscriptionRepository.update({
        ...subscription.toObject(),
        stripeCustomerId: customer.id,
      });
    } else {
      subscription = await SubscriptionRepository.create({
        organization: organization._id,
        stripeCustomerId: customer.id,
      });
    }
  }

  const session = await stripe.checkout.sessions.create({
    customer: subscription.stripeCustomerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return session.url;
};

/**
 * @desc Create a Stripe Customer Portal session for the given organization
 * @param {Object} organization - The organization document
 * @returns {Promise<String>} Portal session URL
 */
const createPortalSession = async (organization) => {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured');

  const subscription = await SubscriptionRepository.findByOrganization(organization._id);
  if (!subscription?.stripeCustomerId) throw new Error('No Stripe customer found for this organization');

  const session = await stripe.billingPortal.sessions.create({
    customer: subscription.stripeCustomerId,
  });

  return session.url;
};

/**
 * @desc Get subscription for the given organization
 * @param {String} organizationId - The organization ID
 * @returns {Promise<Object|null>} The subscription document or null
 */
const getSubscription = async (organizationId) => SubscriptionRepository.findByOrganization(organizationId);

export default {
  createCheckout,
  createPortalSession,
  getSubscription,
};
