/**
 * Audit ability definitions for CASL document-level authorization.
 */

/**
 * Register audit-related subjects for path-level resolution.
 * @param {Object} registry - Subject registration helpers
 * @param {Function} registry.registerPathSubject - Register route path → subject type
 */
export function auditSubjectRegistration({ registerPathSubject }) {
  registerPathSubject((p) => p.startsWith('/api/audit'), 'AuditLog');
}

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
