/**
 * User admin ability definitions for CASL document-level authorization.
 * Uses 'UserAdmin' for admin user-management routes (:userId, page/:userPage).
 * Uses 'UserSelf' read for the admin user list at GET /api/users.
 */

/**
 * Define admin-level user management abilities for an authenticated user.
 * Only admins can list, get, update, and delete other users.
 * The admin list at GET /api/users requires read on 'UserSelf'.
 * @param {Object} user - The authenticated user
 * @param {Object|null} membership - Optional organization membership (reserved for future use)
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 */
export function userAdminAbilities(user, membership, { can }) {
  if (user.roles.includes('admin')) {
    can('manage', 'UserAdmin');
    can('read', 'UserSelf');
  }
}
