/**
 * Module dependencies
 */
import responses from './responses.js';

/**
 * Simple middleware helper for route-level CASL authorization.
 * Designed to run after policy.isAllowed (which attaches req.ability).
 * Usage: router.get('/api/users/me', authorize('read', 'UserAccount'), controller.me);
 *
 * @param {string} action - CASL action (read, create, update, delete)
 * @param {string} subject - CASL subject type string
 * @returns {Function} Express middleware
 */
const authorize = (action, subject) => (req, res, next) => {
  if (req.ability && req.ability.can(action, subject)) return next();
  return responses.error(res, 403, 'Unauthorized', 'User is not authorized')();
};

export default authorize;
