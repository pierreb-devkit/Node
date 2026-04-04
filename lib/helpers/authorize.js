/**
 * Simple middleware helper for route-level CASL authorization.
 * Usage: router.get('/tasks', authorize('read', 'Task'), controller.list);
 *
 * @param {string} action - CASL action (read, create, update, delete)
 * @param {string} subject - CASL subject type string
 * @returns {Function} Express middleware
 */
const authorize = (action, subject) => (req, res, next) => {
  if (req.ability && req.ability.can(action, subject)) return next();
  return res.status(403).json({ type: 'error', message: 'Forbidden' });
};

export default authorize;
