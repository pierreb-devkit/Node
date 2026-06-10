/**
 * Signup-invitation abilities for CASL document/path authorization.
 */

/**
 * Register the invitations path → subject mapping.
 * Matches BOTH the canonical mount (`/api/invitations`, served by this module's
 * routes) and the back-compat alias (`/api/auth/invitations`, still declared in
 * auth.routes.js before the greedy `/api/auth/:strategy` wildcard until the Vue
 * admin store migrates off it) so admin CRUD stays authorized on either path.
 * @param {Object} registry
 * @param {Function} registry.registerPathSubject
 * @returns {void}
 */
export function invitationSubjectRegistration({ registerPathSubject }) {
  registerPathSubject((p) => p.startsWith('/api/invitations') || p.startsWith('/api/auth/invitations'), 'Invitation');
}

/**
 * Only platform admins can manage signup invitations.
 * @param {Object} user
 * @param {Object|null} membership
 * @param {Object} builder
 * @param {Function} builder.can
 * @returns {void}
 */
export function invitationAbilities(user, membership, { can }) {
  if (Array.isArray(user?.roles) && user.roles.includes('admin')) can('manage', 'all');
}
