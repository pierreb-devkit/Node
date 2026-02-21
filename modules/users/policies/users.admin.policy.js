/**
 * Module dependencies
 * */
import policy from '../../../lib/middlewares/policy.js';

/**
 * Invoke Users Admin Permissions
 */
const invokeRolesPolicies = () => {
  policy.registerRules([
    { roles: ['admin'], actions: ['read'], subject: '/api/users' },
    { roles: ['admin'], actions: ['read'], subject: '/api/users/page/:userPage' },
    { roles: ['admin'], actions: ['read', 'update', 'delete'], subject: '/api/users/:userId' },
  ]);
};

export default {
  invokeRolesPolicies,
};
