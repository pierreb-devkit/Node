/**
 * Stripe subscription statuses that indicate an active subscription.
 * Any status not in this list is treated as inactive (falls back to free plan).
 */
export const activeStatuses = ['active', 'trialing'];

/**
 * Stripe subscription statuses that fail closed — billed and gated as if the
 * organization were on the default (free) plan. Shared by billing.quota.service.js
 * (the admission gate) and billing.usage.service.js (the meter) so the two
 * enforcement paths can never drift apart: duplicating this list in both places let
 * the gate treat a fail-closed status as free while the meter kept consuming the
 * paid quota (#4151).
 */
export const failClosedStatuses = ['paused', 'unpaid', 'incomplete_expired', 'incomplete', 'canceled'];
