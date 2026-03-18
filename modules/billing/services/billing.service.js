/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import getStripe from '../lib/stripe.js';
import BillingPlansService from './billing.plans.service.js';
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';

/**
 * Validate that a redirect URL is safe for the current environment.
 * In production the URL must use HTTPS and, when config.domain is set,
 * its hostname must match the application domain.
 * In development / test only basic URL parsing is enforced (HTTP allowed,
 * any hostname accepted) so that localhost workflows are not blocked.
 * @param {String} url - URL to validate
 * @returns {Boolean} true if valid
 */
const isAllowedUrl = (url) => {
  try {
    const parsed = new URL(url);
    const env = process.env.NODE_ENV || 'development';
    const allowHttp = env === 'development' || env === 'test';
    const allowedProtocols = allowHttp ? ['http:', 'https:'] : ['https:'];
    if (!allowedProtocols.includes(parsed.protocol)) return false;
    if (config.domain && !allowHttp) {
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
    throw new Error('Invalid redirect URL: must be a valid URL (production requires HTTPS and a matching application domain)');
  }

  // Validate priceId against known active Stripe prices and resolve the canonical plan id
  if (typeof priceId !== 'string' || !priceId.trim()) {
    throw new Error('Invalid priceId: must be an active published price');
  }
  const plans = await BillingPlansService.getPlans();
  const matchedPlan = plans.find(
    (p) => (p.stripePriceMonthly && p.stripePriceMonthly === priceId)
      || (p.stripePriceAnnual && p.stripePriceAnnual === priceId),
  );
  if (!matchedPlan) {
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
      try {
        subscription = await SubscriptionRepository.create({
          organization: organization._id,
          stripeCustomerId: customer.id,
        });
      } catch (err) {
        if (err.code === 11000) {
          subscription = await SubscriptionRepository.findByOrganization(organization._id);
        } else {
          throw err;
        }
      }
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
    metadata: {
      organizationId: String(organization._id),
      plan: matchedPlan.planId,
    },
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
    if (!isAllowedUrl(returnUrl)) throw new Error('Invalid return URL: must be a valid URL (production requires HTTPS and a matching application domain)');
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
