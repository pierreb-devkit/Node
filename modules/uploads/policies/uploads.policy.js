/**
 * Module dependencies
 * */
import policy from '../../../lib/middlewares/policy.js';

/**
 * Invoke Uploads Permissions
 */
const invokeRolesPolicies = () => {
  policy.registerRules([
    { roles: ['user', 'admin'], actions: ['read', 'delete'], subject: '/api/uploads/:uploadName' },
    { roles: ['guest', 'user', 'admin'], actions: ['read'], subject: '/api/uploads/images/:imageName' },
  ]);
};

export default {
  invokeRolesPolicies,
};
