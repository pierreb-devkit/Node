/**
 * Audit ability definitions for CASL document-level authorization.
 */

/**
 * Define audit-related abilities for an authenticated user.
 * Only platform admins can read audit logs.
 * @param {Object} user - The authenticated user
 * @param {Object|null} membership - Optional organization membership
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 */
export function auditAbilities(user, membership, { can }) {
  if (Array.isArray(user?.roles) && user.roles.includes('admin')) {
    can('read', 'AuditLog');
  }
}
