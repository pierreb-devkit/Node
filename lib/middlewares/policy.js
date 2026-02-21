/**
 * Module dependencies
 */
import responses from '../helpers/responses.js';

const methodToAction = {
  get: 'read', post: 'create', put: 'update', patch: 'update', delete: 'delete',
};

// Global rules registry — populated at startup by each policy file
const rulesRegistry = [];

const registerRules = (rules) => rulesRegistry.push(...rules);

// Lazy CASL loader — dynamic import avoids Jest's experimental VM module linker
let _casl = null;
const loadCasl = async () => {
  if (!_casl) _casl = await import('@casl/ability');
  return _casl;
};

const defineAbilityFor = async (user) => {
  const { AbilityBuilder, Ability } = await loadCasl();
  const { can, build } = new AbilityBuilder(Ability);
  const roles = user ? user.roles : ['guest'];
  for (const rule of rulesRegistry) {
    if (rule.roles.some((r) => roles.includes(r))) {
      can(rule.actions, rule.subject);
    }
  }
  return build();
};

/**
 * @desc MiddleWare to check if user is allowed
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const isAllowed = async (req, res, next) => {
  const ability = await defineAbilityFor(req.user);
  const action = methodToAction[req.method.toLowerCase()];
  if (ability.can(action, req.route.path)) return next();
  return responses.error(res, 403, 'Unauthorized', 'User is not authorized')();
};

/**
 * @desc MiddleWare to check if user is owner
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const isOwner = (req, res, next) => {
  if (req.user && req.isOwner && String(req.isOwner) === String(req.user._id)) {
    return next();
  }
  return responses.error(res, 403, 'Unauthorized', 'User is not authorized')();
};

export default {
  registerRules,
  defineAbilityFor,
  isAllowed,
  isOwner,
};
