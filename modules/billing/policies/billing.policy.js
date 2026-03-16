/**
 * Billing ability definitions for CASL document-level authorization.
 */

/**
 * Define billing-related abilities for an authenticated user.
 * Any authenticated user with an organization membership can manage billing.
 * @param {Object} user - The authenticated user
 * @param {Object|null} membership - Optional organization membership
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 * @param {Function} builder.cannot - Deny an ability
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars
export function billingAbilities(user, membership, { can, cannot }) {
  if (Array.isArray(user?.roles) && user.roles.includes('admin')) {
    can('manage', 'all');
    return;
  }

  if (!membership) return;

  can('create', 'BillingCheckout');
  can('create', 'BillingPortal');
  can('read', 'BillingSubscription');
}

/**
 * Define billing-related abilities for guest (unauthenticated) users.
 * Guests can read billing plans (public route).
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 * @returns {void}
 */
export function billingGuestAbilities({ can }) {
  can('read', 'BillingPlans');
}
