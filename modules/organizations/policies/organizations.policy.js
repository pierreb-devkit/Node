/**
 * Organization ability definitions for CASL document-level authorization.
 */

/**
 * Define organization-related abilities for an authenticated user.
 * Platform admins get full access. Regular users get abilities based on
 * their organization membership role (owner, admin, member).
 * @param {Object} user - The authenticated user
 * @param {Object|null} membership - Optional organization membership
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 * @param {Function} builder.cannot - Deny an ability
 */
export function organizationAbilities(user, membership, { can, cannot }) {
  if (user.roles.includes('admin')) {
    can('manage', 'all');
    return;
  }

  // Any authenticated user can create an organization
  can('create', 'Organization');

  if (!membership) return;

  switch (membership.role) {
    case 'owner':
      can('manage', 'Organization', { _id: String(membership.organizationId._id || membership.organizationId) });
      can('manage', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      break;
    case 'admin':
      can('read', 'Organization', { _id: String(membership.organizationId._id || membership.organizationId) });
      can('update', 'Organization', { _id: String(membership.organizationId._id || membership.organizationId) });
      can('manage', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      cannot('delete', 'Organization');
      break;
    case 'member':
      can('read', 'Organization', { _id: String(membership.organizationId._id || membership.organizationId) });
      can('read', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      break;
  }
}
