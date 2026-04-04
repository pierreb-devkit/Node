/**
 * Developers ability definitions for CASL document-level authorization.
 */

/**
 * Define developers-related abilities for an authenticated user.
 * Requires an organization membership to manage API keys and webhooks.
 * @param {Object} user - The authenticated user
 * @param {Object|null} membership - Optional organization membership
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 * @param {Function} builder.cannot - Deny an ability
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars
export function developersAbilities(user, membership, { can, cannot }) {
  if (Array.isArray(user?.roles) && user.roles.includes('admin')) {
    can('manage', 'all');
    return;
  }

  if (!membership) return;

  const organizationId = String(membership.organizationId);
  can('create', 'DeveloperKey', { organizationId });
  can('read', 'DeveloperKey', { organizationId });
  can('delete', 'DeveloperKey', { organizationId });
  can('create', 'DeveloperWebhook', { organizationId });
  can('read', 'DeveloperWebhook', { organizationId });
  can('update', 'DeveloperWebhook', { organizationId });
  can('delete', 'DeveloperWebhook', { organizationId });
}
