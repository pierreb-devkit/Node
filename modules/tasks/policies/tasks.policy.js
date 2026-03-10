/**
 * Task ability definitions for CASL document-level authorization.
 */

/**
 * Define task-related abilities for an authenticated user.
 * Platform admins get full access. Regular users can read and create
 * any task, but can only update/delete their own tasks (ownership check).
 * @param {Object} user - The authenticated user
 * @param {Object|null} membership - Optional organization membership (reserved for future use)
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 * @param {Function} builder.cannot - Deny an ability
 */
export function taskAbilities(user, membership, { can }) {
  if (user.roles.includes('admin')) {
    can('manage', 'all');
    return;
  }
  can('read', 'Task');
  can('create', 'Task');
  can('update', 'Task', { user: String(user._id) });
  can('delete', 'Task', { user: String(user._id) });
}

/**
 * Define task-related abilities for unauthenticated guests.
 * Guests can only read tasks and task stats.
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 */
export function taskGuestAbilities({ can }) {
  can('read', 'Task');
}
