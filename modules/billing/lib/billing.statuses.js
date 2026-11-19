/**
 * Stripe subscription statuses that indicate an active subscription.
 * Any status not in this list is treated as inactive (falls back to free plan).
 */
export const activeStatuses = ['active', 'trialing'];

/**
 * Stripe subscription statuses under which the provider is still charging (or retrying
 * a charge): an organization in one of them cannot be removed until it cancels (#4321).
 */
export const liveStatuses = ['active', 'trialing', 'past_due'];

/**
 * The one rule for "this organization has a live paid subscription": a provider
 * subscription id is stored AND its status is live. The shell row created for a free
 * organization that only opened checkout carries the default 'active' status but no
 * subscription id, so it is not live. Shared by the checkout block (no second
 * subscription) and the organization-removal guard.
 * @param {{ status?: string, stripeSubscriptionId?: string|null }|null|undefined} subscription - Local subscription document.
 * @returns {boolean} true while the provider is (or may be) charging.
 */
export const hasLiveSubscription = (subscription) =>
  Boolean(subscription?.stripeSubscriptionId && liveStatuses.includes(subscription.status));

/**
 * The one rule for "this subscription is already set to end": the provider will stop
 * charging on its own. Stripe records a cancellation two ways and the webhook stores
 * both: at period end (`cancelAtPeriodEnd: true`) or at a set date (`cancelAt`, what a
 * customer-portal cancel writes, with `cancelAtPeriodEnd` left false).
 * @param {{ cancelAtPeriodEnd?: boolean, cancelAt?: Date|string|null }|null|undefined} subscription - Local subscription document.
 * @returns {boolean} true when a cancellation is scheduled.
 */
export const isSetToEnd = (subscription) => Boolean(subscription?.cancelAtPeriodEnd === true || subscription?.cancelAt);

/**
 * The one rule for the plan an organization is entitled to: the subscription's plan
 * while its status is active or trialing, 'free' otherwise (no subscription, no plan,
 * or any other status).
 * @param {{ status?: string, plan?: string }|null|undefined} subscription - Local subscription document.
 * @returns {string} The effective plan id.
 */
export const effectivePlanOf = (subscription) =>
  (!subscription || !activeStatuses.includes(subscription.status) ? 'free' : subscription.plan || 'free');

/**
 * Stripe subscription statuses that fail closed — billed and gated as if the
 * organization were on the default (free) plan. Shared by billing.quota.service.js
 * (the admission gate) and billing.usage.service.js (the meter) so the two
 * enforcement paths can never drift apart: duplicating this list in both places let
 * the gate treat a fail-closed status as free while the meter kept consuming the
 * paid quota (#4151).
 */
export const failClosedStatuses = ['paused', 'unpaid', 'incomplete_expired', 'incomplete', 'canceled'];
