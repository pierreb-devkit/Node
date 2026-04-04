/**
 * Account ability definitions for CASL document-level authorization.
 * Uses 'UserAccount' for self-service routes (me, terms, password, avatar, data, stats).
 * Uses 'UserSelf' for the base /api/users path (update/delete own account).
 */

/**
 * Register user account-related subjects for path-level resolution.
 * Exact matches are registered first (highest priority), then prefix fallback.
 * @param {Object} registry - Subject registration helpers
 * @param {Function} registry.registerPathSubject - Register route path → subject type
 */
export function usersSubjectRegistration({ registerPathSubject }) {
  // Exact matches — checked before prefix fallback
  registerPathSubject('/api/users/me', 'UserAccount');
  registerPathSubject('/api/users/terms', 'UserAccount');
  registerPathSubject('/api/users/password', 'UserAccount');
  registerPathSubject('/api/users/avatar', 'UserAccount');
  registerPathSubject('/api/users/data', 'UserAccount');
  registerPathSubject('/api/users/data/mail', 'UserAccount');
  registerPathSubject('/api/users/stats', 'UserStats');
  registerPathSubject('/api/users', 'UserSelf');
  // Prefix fallback for any other /api/users/* routes
  registerPathSubject((p) => p.startsWith('/api/users'), 'UserAccount');
}

/**
 * Define account-related abilities for an authenticated user.
 * Regular users can manage their own account via self-service routes.
 * 'UserSelf' only grants update and delete — read on /api/users is admin-only.
 * Admins get full access to everything.
 * @param {Object} user - The authenticated user
 * @param {Object|null} membership - Optional organization membership (reserved for future use)
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 */
export function usersAbilities(user, membership, { can }) {
  if (Array.isArray(user?.roles) && user.roles.includes('admin')) {
    can('manage', 'all');
    return;
  }
  // Self-service routes (me, terms, password, avatar, data)
  can('read', 'UserAccount');
  can('create', 'UserAccount');
  can('update', 'UserAccount');
  can('delete', 'UserAccount');
  // Stats route (also guest-accessible via UserStats)
  can('read', 'UserStats');
  // Base /api/users route — users can update/delete their own account but NOT list users
  can('update', 'UserSelf');
  can('delete', 'UserSelf');
}

/**
 * Define account-related abilities for unauthenticated guests.
 * Guests can only read user stats (which is a UserAccount route).
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 */
export function usersGuestAbilities({ can }) {
  can('read', 'UserStats');
}
