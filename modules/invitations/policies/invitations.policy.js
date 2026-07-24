/**
 * Signup-invitation abilities for CASL document/path authorization.
 */
import config from '../../../config/index.js';

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
 * Platform admins keep full management of signup invitations. When
 * `config.invitations.userFacing` is on (#3945, default OFF — preserves existing
 * deployments' admin-only behavior), any other authenticated user can create their
 * OWN invitation (a referral link) and read invitations THEY sent.
 *
 * Both grants below are TYPE-level (collection) CASL rules: no Invitation
 * document-subject is registered (invitationSubjectRegistration only registers a
 * path-subject), so a per-document `invitedBy` condition would never be evaluated —
 * adding one here would be decorative and misleading. The REAL invitedBy-scoping for
 * `read` is enforced downstream in InvitationsService.list() (#3833, deliberately
 * mirrored there). This is also WHY no document-subject is registered: the
 * `/invitations/:id/resend` route is a POST, which the generic HTTP-method→CASL-action
 * map (methodToAction) resolves to the SAME 'create' action as new-invitation creation —
 * granting 'create' at the type level would otherwise also open resend to any invitee.
 * invitations.controller.js's `resend` explicitly stays admin-gated to close that gap;
 * `remove` (revoke) is safe as-is because non-admins are never granted 'delete'.
 * @param {Object} user
 * @param {Object|null} membership
 * @param {Object} builder
 * @param {Function} builder.can
 * @returns {void}
 */
export function invitationAbilities(user, membership, { can }) {
  if (Array.isArray(user?.roles) && user.roles.includes('admin')) {
    can('manage', 'all');
    return;
  }
  if (config.invitations?.userFacing) {
    can('create', 'Invitation');
    can('read', 'Invitation');
  }
}
