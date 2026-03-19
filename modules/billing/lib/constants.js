/**
 * Stripe subscription statuses that indicate an active subscription.
 * Any status not in this list is treated as inactive (falls back to free plan).
 */
export const activeStatuses = ['active', 'trialing'];
