/**
 * @module organizations/lib/organizations.signup.registry
 * @description Resolver registry for signup memberships.
 *   Optional modules register a resolver at boot via `registerSignupMembershipResolver`;
 *   `handleSignupOrganization` asks them, just before its A4 "existing active membership"
 *   guard, whether the user signing up should JOIN an existing organization instead of
 *   getting a personal workspace (e.g. the invitations module answers for an organization
 *   invite). The first non-null answer wins. No resolver registered = no join (today's
 *   behaviour). Config-free, import-safe leaf: organizations never imports the modules
 *   that register here.
 */

const resolvers = [];

/**
 * @function registerSignupMembershipResolver
 * @description Register a resolver asked at signup provisioning. De-duped by identity
 *   (a module init running twice registers once).
 * @param {(user: Object) => (Promise<{organizationId: *, role?: string, invitedBy?: *}|null|undefined>)} fn
 *   Receives the user being provisioned; returns the organization to join, or nothing.
 * @returns {void}
 */
export const registerSignupMembershipResolver = (fn) => {
  if (typeof fn !== 'function') throw new TypeError('registerSignupMembershipResolver: fn must be a function');
  if (!resolvers.includes(fn)) resolvers.push(fn);
};

/**
 * @function resolveSignupMembership
 * @description Ask every resolver in registration order; return the first non-null answer.
 *   A resolver error propagates to the caller (signup rolls back and the invite is released).
 * @param {Object} user - The user being provisioned.
 * @returns {Promise<{organizationId: *, role?: string, invitedBy?: *}|null>}
 */
export const resolveSignupMembership = async (user) => {
  for (const fn of resolvers) {
    const result = await fn(user);
    if (result != null) return result;
  }
  return null;
};

/**
 * @function _reset
 * @description Test helper — clears all registered resolvers.
 * @returns {void}
 */
export const _reset = () => {
  resolvers.length = 0;
};

export default { registerSignupMembershipResolver, resolveSignupMembership, _reset };
