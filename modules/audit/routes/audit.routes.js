/**
 * Module dependencies
 */
import passport from 'passport';

import policy from '../../../lib/middlewares/policy.js';
import audit from '../controllers/audit.controller.js';

/**
 * Register audit routes.
 * @param {import('express').Application} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  // Audit log — admin only, paginated, filterable
  app
    .route('/api/audit')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(audit.list);
};
