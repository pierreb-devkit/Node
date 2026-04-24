/**
 * @desc True when the authenticated user has the global 'admin' role.
 *   Use sparingly — prefer CASL abilities for per-resource checks. This
 *   helper is only for belt-and-suspenders guards inside controllers that
 *   need to bypass org-scoped membership checks (moderation endpoints).
 * @param {Object} user - req.user object (may be undefined)
 * @returns {boolean}
 */
const isGlobalAdmin = (user) => Array.isArray(user?.roles) && user.roles.includes('admin');

export default isGlobalAdmin;
