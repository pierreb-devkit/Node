/**
 * Module dependencies
 * */
import policy from '../../../lib/middlewares/policy.js';

/**
 * Invoke Home Permissions
 */
const invokeRolesPolicies = () => {
  policy.registerRules([
    { roles: ['guest'], actions: ['read'], subject: '/api/home/releases' },
    { roles: ['guest'], actions: ['read'], subject: '/api/home/changelogs' },
    { roles: ['guest'], actions: ['read'], subject: '/api/home/team' },
    { roles: ['guest'], actions: ['read'], subject: '/api/home/pages/:name' },
  ]);
};

export default {
  invokeRolesPolicies,
};
