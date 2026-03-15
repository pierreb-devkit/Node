/**
 * Module dependencies
 */
import passport from 'passport';

import policy from '../../../lib/middlewares/policy.js';
import organizations from '../controllers/organizations.controller.js';

/**
 * Routes
 */
export default (app) => {
  /**
   * Admin Organizations
   */

  app
    .route('/api/admin/organizations')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(organizations.adminList);

  app.route('/api/admin/organizations/page/:orgPage').get(passport.authenticate('jwt', { session: false }), policy.isAllowed, organizations.adminList);

  // Bind param middleware
  app.param('orgPage', organizations.organizationByPage);
};
