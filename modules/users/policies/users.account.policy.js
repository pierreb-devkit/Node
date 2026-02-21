/**
 * Module dependencies
 * */
import policy from '../../../lib/middlewares/policy.js';

/**
 * Invoke Users Account Permissions
 */
const invokeRolesPolicies = () => {
  policy.registerRules([
    { roles: ['user'], actions: ['read'], subject: '/api/users/me' },
    { roles: ['user'], actions: ['read'], subject: '/api/users/terms' },
    { roles: ['user'], actions: ['update', 'delete'], subject: '/api/users' },
    { roles: ['user'], actions: ['create'], subject: '/api/users/password' },
    { roles: ['user'], actions: ['create', 'delete'], subject: '/api/users/avatar' },
    { roles: ['user'], actions: ['create', 'delete'], subject: '/api/users/accounts' },
    { roles: ['user'], actions: ['read', 'delete'], subject: '/api/users/data' },
    { roles: ['user'], actions: ['read'], subject: '/api/users/data/mail' },
    { roles: ['guest'], actions: ['read'], subject: '/api/users/stats' },
  ]);
};

export default {
  invokeRolesPolicies,
};
