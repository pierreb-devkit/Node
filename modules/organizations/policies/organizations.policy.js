/**
 * Organization ability definitions for CASL document-level authorization.
 */
import { MEMBERSHIP_ROLES } from '../lib/constants.js';

/**
 * Whether a route path targets an organization resource (regular or platform-admin form).
 * Both surfaces share the same /members and /requests sub-resources, so their dedicated
 * Membership path-subjects must match either prefix.
 * @param {string} p - Express route path
 * @returns {boolean} true for both /api/organizations and /api/admin/organizations
 */
const isOrganizationRoute = (p) => p.startsWith('/api/organizations') || p.startsWith('/api/admin/organizations');

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
  //
  // The /members routes are deliberately EXCLUDED: req.organization is loaded there too,
  // but membership management must authorize via the dedicated Membership path-subject
  // (owner/admin gate), NOT the unconditional `create Organization` grant — otherwise the
  // Organization document-subject is resolved first (resolveSubject is first-match-wins) and
  // shadows the Membership subject, letting any authenticated user inject a membership.
  // Do NOT exclude /requests — that is the any-user JOIN-REQUEST flow, which legitimately
  // relies on `create Organization` (excluding it would 403 legitimate join requests).
  registerDocumentSubject('organization', 'Organization', (req) => {
    if (!req.route?.path) {
      return false;
    }
    const p = req.route.path;
    return isOrganizationRoute(p) && !p.includes('/members');
  });
  // Admin organization routes resolve to the Organization subject, EXCEPT /members:
  // membership management must authorize via the dedicated Membership path-subject below,
  // mirroring the organization document-subject guard. Without this carve-out the broad
  // admin Organization match would shadow the Membership entry (resolution is first-match-wins),
  // so an admin /members path would resolve to Organization instead of Membership.
  registerPathSubject((p) => p.startsWith('/api/admin/organizations') && !p.includes('/members'), 'Organization');
  registerPathSubject((p) => isOrganizationRoute(p) && p.includes('/requests'), 'Membership');
  registerPathSubject((p) => isOrganizationRoute(p) && p.includes('/members'), 'Membership');
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
    case MEMBERSHIP_ROLES.OWNER:
      can('manage', 'Organization', { _id: String(membership.organizationId._id || membership.organizationId) });
      can('manage', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      break;
    case MEMBERSHIP_ROLES.ADMIN:
      can('read', 'Organization', { _id: String(membership.organizationId._id || membership.organizationId) });
      can('update', 'Organization', { _id: String(membership.organizationId._id || membership.organizationId) });
      cannot('delete', 'Organization');
      can('read', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      can('create', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      can('delete', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      break;
    case MEMBERSHIP_ROLES.MEMBER:
      can('read', 'Organization', { _id: String(membership.organizationId._id || membership.organizationId) });
      can('read', 'Membership', { organizationId: String(membership.organizationId._id || membership.organizationId) });
      break;
  }
}
