/**
 * Home ability definitions for CASL document-level authorization.
 */

/**
 * Define home-related abilities for an authenticated user.
 * All authenticated users can read home content (releases, changelogs, team, pages).
 * @param {Object} user - The authenticated user
 * @param {Object|null} membership - Optional organization membership (reserved for future use)
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 */
export function homeAbilities(user, membership, { can }) {
  can('read', 'Home');
  if (Array.isArray(user?.roles) && user.roles.includes('admin')) {
    can('manage', 'Readiness');
  }
}

/**
 * Define home-related abilities for unauthenticated guests.
 * Guests can read all home content (releases, changelogs, team, pages).
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 */
export function homeGuestAbilities({ can }) {
  can('read', 'Home');
}
