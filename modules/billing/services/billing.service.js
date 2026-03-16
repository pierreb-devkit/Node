/**
 * Module dependencies
 */
import Stripe from 'stripe';

import config from '../../../config/index.js';
import BillingPlansService from './billing.plans.service.js';
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
 * @desc Validate that a URL uses https (or http in dev/test) and belongs to the app domain
 * @param {String} url - URL to validate
 * @returns {Boolean} true if valid
 */
const isAllowedUrl = (url) => {
  try {
    const parsed = new URL(url);
    const allowHttp = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    if (!allowHttp && parsed.protocol !== 'https:') return false;
    if (config.domain) {
      const configHost = new URL(config.domain.startsWith('http') ? config.domain : `https://${config.domain}`).hostname;
      if (parsed.hostname !== configHost) return false;
    }
    return true;
  } catch {
    return false;
  }
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

  if (!isAllowedUrl(successUrl) || !isAllowedUrl(cancelUrl)) {
    throw new Error('Invalid redirect URL: must use HTTPS and match the application domain');
  }

  // Validate priceId against known active Stripe prices
  const plans = await BillingPlansService.getPlans();
  const allowedPriceIds = plans.flatMap((p) => [p.stripePriceMonthly, p.stripePriceAnnual].filter(Boolean));
  if (!allowedPriceIds.includes(priceId)) {
    throw new Error('Invalid priceId: must be an active published price');
  }

  // Find or create subscription record with Stripe customer
  let subscription = await SubscriptionRepository.findByOrganization(organization._id);

  if (!subscription?.stripeCustomerId) {
    const customer = await stripe.customers.create(
      {
        name: organization.name,
        metadata: { organizationId: String(organization._id) },
      },
      { idempotencyKey: `cus_create_${String(organization._id)}` },
    );

    if (subscription) {
      subscription = await SubscriptionRepository.update({
        _id: subscription._id,
        stripeCustomerId: customer.id,
      });
    } else {
      subscription = await SubscriptionRepository.create({
        organization: organization._id,
        stripeCustomerId: customer.id,
      });
    }
    // Re-read to handle race: if another request already set stripeCustomerId, use that
    const latest = await SubscriptionRepository.findByOrganization(organization._id);
    if (latest?.stripeCustomerId) subscription = latest;
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
 * @param {String} returnUrl - Optional URL to redirect back to after portal
 * @returns {Promise<String>} Portal session URL
 */
const createPortalSession = async (organization, returnUrl) => {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured');

  const subscription = await SubscriptionRepository.findByOrganization(organization._id);
  if (!subscription?.stripeCustomerId) throw new Error('No Stripe customer found for this organization');

  const params = { customer: subscription.stripeCustomerId };
  if (returnUrl) {
    if (!isAllowedUrl(returnUrl)) throw new Error('Invalid return URL: must use HTTPS and match the application domain');
    params.return_url = returnUrl;
  }

  const session = await stripe.billingPortal.sessions.create(params);

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
