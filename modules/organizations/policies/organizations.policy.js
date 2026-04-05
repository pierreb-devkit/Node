/**
 * Organization ability definitions for CASL document-level authorization.
 */

/**
 * Register organization-related subjects for document-level and path-level resolution.
 * The organization document subject uses a guard to exclude billing routes (which
 * set req.organization but authorize via their own path-derived subjects).
 * @param {Object} registry - Subject registration helpers
 * @param {Function} registry.registerDocumentSubject - Register req property → subject type
 * @param {Function} registry.registerPathSubject - Register route path → subject type
 * @returns {void}
 */
export function organizationSubjectRegistration({ registerDocumentSubject, registerPathSubject }) {
  registerDocumentSubject('membershipDoc', 'Membership');
  // Guard: only resolve req.organization as an Organization subject on actual organization routes.
  // Other modules (billing, tasks, etc.) also set req.organization but authorize via their own subjects.
  registerDocumentSubject('organization', 'Organization', (req) => {
    if (!req.route?.path) {
      return false;
    }
    const p = req.route.path;
    return p.startsWith('/api/organizations') || p.startsWith('/api/admin/organizations');
  });
  registerPathSubject((p) => p.startsWith('/api/admin/organizations'), 'Organization');
  registerPathSubject((p) => p.startsWith('/api/organizations') && p.includes('/requests'), 'Membership');
  registerPathSubject((p) => p.startsWith('/api/organizations') && p.includes('/members'), 'Membership');
  registerPathSubject((p) => p.startsWith('/api/organizations'), 'Organization');
}

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
  if (Array.isArray(user?.roles) && user.roles.includes('admin')) {
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
      cannot('delete', 'Organization');
      can('read', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      can('create', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      can('delete', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      break;
    case 'member':
      can('read', 'Organization', { _id: String(membership.organizationId._id || membership.organizationId) });
      can('read', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      break;
  }
}
