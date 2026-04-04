/**
 * Task ability definitions for CASL document-level authorization.
 */

/**
 * Register task-related subjects for document-level and path-level resolution.
 * Called automatically by discoverPolicies() during startup.
 * @param {Object} registry - Subject registration helpers
 * @param {Function} registry.registerDocumentSubject - Register req property → subject type
 * @param {Function} registry.registerPathSubject - Register route path → subject type
 * @returns {void}
 */
export function taskSubjectRegistration({ registerDocumentSubject, registerPathSubject }) {
  registerDocumentSubject('task', 'Task');
  registerPathSubject((p) => p.startsWith('/api/tasks'), 'Task');
}

/**
 * Define task-related abilities for an authenticated user.
 * Platform admins get full access. When an organization membership exists,
 * abilities are scoped to the organization via organizationId conditions.
 * Without a membership (no org context), users receive no task abilities
 * and cannot access tasks.
 * @param {Object} user - The authenticated user
 * @param {Object|null} membership - Optional organization membership
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 * @param {Function} builder.cannot - Deny an ability
 */
export function taskAbilities(user, membership, { can }) {
  if (Array.isArray(user?.roles) && user.roles.includes('admin')) {
    can('manage', 'all');
    return;
  }
  if (!membership) return; // No org membership — no task access
  const organizationId = String(membership.organizationId);
  can('create', 'Task', { organizationId });
  can('read', 'Task', { organizationId });
  can('update', 'Task', { organizationId, user: String(user._id) });
  can('delete', 'Task', { organizationId, user: String(user._id) });
}

