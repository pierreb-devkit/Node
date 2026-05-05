/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import getStripe from '../lib/stripe.js';
import BillingPlansService from './billing.plans.service.js';
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';
import { isDuplicateKeyError } from '../lib/billing.errors.js';
import { SENTINEL_PENDING } from '../lib/billing.constants.js';

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
 * @function _ensureStripeCustomer
 * @description Find or create the billing subscription shell that carries a Stripe customer id.
 * @param {Object} stripe - Stripe client instance.
 * @param {Object} organization - Organization document.
 * @returns {Promise<Object>} Subscription document with stripeCustomerId.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const _ensureStripeCustomer = async (stripe, organization) => {
  let subscription = await SubscriptionRepository.findByOrganization(organization._id);
  if (subscription?.stripeCustomerId) return subscription;

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
      if (isDuplicateKeyError(err)) {
        subscription = await SubscriptionRepository.findByOrganization(organization._id);
      } else {
        throw err;
      }
    }
  }

  const latest = await SubscriptionRepository.findByOrganization(organization._id);
  if (latest?.stripeCustomerId) return latest;
  if (subscription?.stripeCustomerId) return subscription;
  throw new Error('No Stripe customer found for this organization');
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

  // Block checkout when an active subscription already exists — direct to portal for changes
  const existingForBlock = await SubscriptionRepository.findByOrganization(organization._id);
  const blockStatuses = ['active', 'trialing', 'past_due'];
  if (existingForBlock?.stripeSubscriptionId && blockStatuses.includes(existingForBlock.status)) {
    const portalUrl = await createPortalSession(organization);
    const err = new Error('Subscription already active');
    err.statusCode = 409;
    err.code = 'subscription_already_active';
    err.portalUrl = portalUrl;
    throw err;
  }

  const subscription = await _ensureStripeCustomer(stripe, organization);

  // Server-side active subscription guard — closes race window between local-DB check and
  // stripe.checkout.sessions.create (webhook may have arrived mid-flight).
  // Fetches status:'all' and filters locally to cover both 'active' AND 'trialing' in one call
  // (Stripe's status filter accepts only a single string, not an array).
  // +1 Stripe API call cost; acceptable given infrequent checkout entry point.
  if (subscription.stripeCustomerId) {
    const liveSubs = await stripe.subscriptions.list({
      customer: subscription.stripeCustomerId,
      status: 'all',
      limit: 10,
    });
    const blockingSub = liveSubs.data.find((s) => ['active', 'trialing'].includes(s.status));
    if (blockingSub) {
      const portalUrl = await createPortalSession(organization);
      const err = new Error('Subscription already active');
      err.statusCode = 409;
      err.code = 'subscription_already_active';
      err.portalUrl = portalUrl;
      throw err;
    }
  }

  const checkoutParams = {
    customer: subscription.stripeCustomerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      organizationId: String(organization._id),
      plan: matchedPlan.planId,
    },
  };
  if (config?.stripe?.automaticTax === true) {
    checkoutParams.automatic_tax = { enabled: true };
    checkoutParams.customer_update = { address: 'auto', name: 'auto' };
  }
  const session = await stripe.checkout.sessions.create(
    checkoutParams,
    { idempotencyKey: `sub_checkout_${String(organization._id)}_${priceId}` },
  );

  return session.url;
};

/**
 * @desc Create a Stripe Checkout Session for an extras pack purchase.
 *       Uses mode:'payment' (one-time) with automatic_tax and idempotency key.
 *
 *       Note on stripeSessionId metadata: Stripe does not allow a session to
 *       self-reference its own id at creation time. The `stripeSessionId` field
 *       is therefore set to the literal string `'__pending__'` during creation.
 *       The webhook handler reads `event.data.object.id` (the actual session id)
 *       directly from the Stripe event — no post-creation patch is needed.
 *
 * @param {Object} organization - The organization document
 * @param {String} packId - Pack identifier (must exist in config.billing.packs)
 * @param {String} successUrl - URL to redirect on payment success
 * @param {String} cancelUrl - URL to redirect on cancel
 * @param {String} [intentId] - Optional stable caller-provided intent ID for idempotency.
 *        When provided: key = `extras_checkout_{orgId}_{packId}_{intentId}` (fully stable).
 *        When absent: key bucketed to the minute — prevents instant double-click but not
 *        cross-minute replay. Callers should pass a UUID generated on button click.
 *        Max 180 chars (Stripe idempotency key limit is 255; prefix consumes ~64 chars).
 * @returns {Promise<{url: String}>} Object with the Checkout session URL
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const createExtrasCheckout = async (organization, packId, successUrl, cancelUrl, intentId) => {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured');

  if (!isAllowedUrl(successUrl) || !isAllowedUrl(cancelUrl)) {
    throw new Error('Invalid redirect URL: must be a valid URL (production requires HTTPS and a matching application domain)');
  }

  // Validate packId against known packs in config
  const packs = config?.billing?.packs ?? [];
  const pack = packs.find((p) => p.packId === packId);
  if (!pack) throw new Error(`Invalid packId: pack not found: ${packId}`);

  // Resolve Stripe price ID for the pack
  const priceId = config?.stripe?.prices?.packs?.[packId];
  if (!priceId) throw new Error(`Invalid packId: no Stripe price configured for pack: ${packId}`);

  const subscription = await _ensureStripeCustomer(stripe, organization);

  // Idempotency key strategy:
  // - If intentId is provided by the caller (e.g. UUID generated on button click): fully stable key.
  // - Otherwise: minute-bucketed key — prevents double-click within the same minute window.
  //   This is strictly better than Date.now()+random (which disabled idempotency entirely).
  const orgId = String(organization._id);
  const idempotencyKey = intentId
    ? `extras_checkout_${orgId}_${packId}_${intentId}`
    : `extras_checkout_${orgId}_${packId}_${Math.floor(Date.now() / 60000)}`;

  const extrasCheckoutParams = {
    customer: subscription.stripeCustomerId,
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      organizationId: orgId,
      packId,
      kind: 'extras',
      stripeSessionId: SENTINEL_PENDING,
    },
    payment_intent_data: {
      metadata: {
        organizationId: orgId,
        packId,
        kind: 'extras',
        stripeSessionId: SENTINEL_PENDING,
      },
    },
  };
  if (config?.stripe?.automaticTax === true) {
    extrasCheckoutParams.automatic_tax = { enabled: true };
    extrasCheckoutParams.customer_update = { address: 'auto', name: 'auto' };
  }
  const session = await stripe.checkout.sessions.create(
    extrasCheckoutParams,
    { idempotencyKey },
  );

  return { url: session.url };
};

/**
 * @desc Fetch live subscription details from Stripe API on-demand.
 *       Used by UI routes that need currentPeriodEnd, cancelAtPeriodEnd etc.
 *       +50ms latency is acceptable on infrequent "My Subscription" page loads.
 *       Not cached — callers can layer a short TTL if needed in the future.
 * @param {String|null} stripeSubscriptionId - Stripe subscription ID (sub_xxx)
 * @returns {Promise<Object|null>} Live fields or null when id is absent / Stripe not configured
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const fetchSubscriptionDetails = async (stripeSubscriptionId) => {
  if (!stripeSubscriptionId) return null;
  const stripe = getStripe();
  if (!stripe) return null;
  const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const cancelAt = stripeSub.cancel_at ? new Date(stripeSub.cancel_at * 1000) : null;
  // Stripe API ≥ 2025-08-27 moved current_period_start/end to items.data[0].
  // Fall back to top-level for older API versions.
  const rawPeriodStart = stripeSub.items?.data?.[0]?.current_period_start ?? stripeSub.current_period_start;
  const rawPeriodEnd = stripeSub.items?.data?.[0]?.current_period_end ?? stripeSub.current_period_end;
  return {
    currentPeriodStart: new Date(rawPeriodStart * 1000),
    currentPeriodEnd: new Date(rawPeriodEnd * 1000),
    cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    status: stripeSub.status,
    nextRenewalDate: cancelAt ?? new Date(rawPeriodEnd * 1000),
  };
};

/**
 * @desc Get subscription for the given organization — local DB only, no Stripe fetch.
 *       Use for lightweight reads (e.g. /usage endpoint) that only need plan/status fields.
 *       Does NOT include currentPeriodEnd, cancelAtPeriodEnd or other live Stripe fields.
 * @param {String} organizationId - The organization ID
 * @returns {Promise<Object|null>} Local subscription document or null
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getLocalSubscription = (organizationId) => SubscriptionRepository.findByOrganization(organizationId);

/**
 * @desc Get subscription for the given organization.
 *       Merges cached local fields with live Stripe details for UI consumers.
 *       Falls back gracefully when Stripe is not configured or the subscription is free.
 * @param {String} organizationId - The organization ID
 * @returns {Promise<Object|null>} Merged subscription object or null
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getSubscription = async (organizationId) => {
  const sub = await SubscriptionRepository.findByOrganization(organizationId);
  if (!sub) return null;
  const details = await fetchSubscriptionDetails(sub.stripeSubscriptionId).catch(() => null);
  if (!details) return sub;
  return { ...sub.toJSON?.() ?? sub, ...details };
};

export default {
  createCheckout,
  createExtrasCheckout,
  createPortalSession,
  fetchSubscriptionDetails,
  getLocalSubscription,
  getSubscription,
};
