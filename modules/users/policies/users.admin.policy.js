/**
 * Admin ability definitions for CASL document-level authorization.
 * Uses 'UserAdmin' for admin user-management routes (:userId, page/:userPage).
 * Uses 'UserSelf' read for the admin user list at GET /api/admin/users.
 */

/**
 * Register admin user-related subjects for document-level and path-level resolution.
 * @param {Object} registry - Subject registration helpers
 * @param {Function} registry.registerDocumentSubject - Register req property → subject type
 * @param {Function} registry.registerPathSubject - Register route path → subject type
 */
export function adminSubjectRegistration({ registerDocumentSubject, registerPathSubject }) {
  registerDocumentSubject('model', 'UserAdmin');
  registerPathSubject((p) => p.startsWith('/api/admin/users'), 'UserAdmin');
}

/**
 * Define admin-level user management abilities for an authenticated user.
 * Only admins can list, get, update, and delete other users.
 * The admin list at GET /api/admin/users requires read on 'UserSelf'.
 * @param {Object} user - The authenticated user
 * @param {Object|null} membership - Optional organization membership (reserved for future use)
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 */
export function adminAbilities(user, membership, { can }) {
  if (Array.isArray(user?.roles) && user.roles.includes('admin')) {
    can('manage', 'UserAdmin');
    can('read', 'UserSelf');
  }
}
