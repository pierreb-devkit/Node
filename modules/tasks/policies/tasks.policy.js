/**
 * Module dependencies
 * */
import policy from '../../../lib/middlewares/policy.js';

/**
 * Invoke Tasks Permissions
 */
const invokeRolesPolicies = () => {
  policy.registerRules([
    { roles: ['user'], actions: 'manage', subject: '/api/tasks' },
    { roles: ['user'], actions: 'manage', subject: '/api/tasks/:taskId' },
    { roles: ['guest'], actions: ['read'], subject: '/api/tasks/stats' },
    { roles: ['guest'], actions: ['read'], subject: '/api/tasks' },
    { roles: ['guest'], actions: ['read'], subject: '/api/tasks/:taskId' },
  ]);
};

export default {
  invokeRolesPolicies,
};
