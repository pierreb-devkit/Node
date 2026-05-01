/**
 * Billing ability definitions for CASL document-level authorization.
 */

/**
 * Register billing-related subjects for path-level resolution.
 * Billing uses exact route matches since each route maps to a distinct subject.
 * @param {Object} registry - Subject registration helpers
 * @param {Function} registry.registerPathSubject - Register route path → subject type
 * @returns {void}
 */
export function billingSubjectRegistration({ registerPathSubject }) {
  registerPathSubject('/api/billing/checkout', 'BillingCheckout');
  registerPathSubject('/api/billing/portal', 'BillingPortal');
  registerPathSubject('/api/billing/subscription', 'BillingSubscription');
  registerPathSubject('/api/billing/usage', 'BillingUsage');
  registerPathSubject('/api/billing/plans', 'BillingPlans');
  // Extras pack purchase + balance/ledger queries
  registerPathSubject('/api/billing/extras/checkout', 'BillingExtrasCheckout');
  registerPathSubject('/api/billing/extras/balance', 'BillingExtrasBalance');
  registerPathSubject('/api/billing/extras/ledger', 'BillingExtrasLedger');
  registerPathSubject('/api/admin/billing/refund', 'BillingAdminRefund');
  registerPathSubject('/api/admin/billing/plans/bump', 'BillingAdminPlanBump');
  // Webhook is mounted in billing.preroute.js before body parsing and auth middleware,
  // so it bypasses policy.isAllowed entirely. Registered here for documentation completeness.
  registerPathSubject('/api/billing/webhook', 'BillingWebhook');
}

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
  can('read', 'BillingUsage');
  // Extras: members can purchase packs and read their own balance/ledger
  can('create', 'BillingExtrasCheckout');
  can('read', 'BillingExtrasBalance');
  can('read', 'BillingExtrasLedger');
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
