/**
 * Module dependencies
 */
import passport from 'passport';

import policy from '../../../lib/middlewares/policy.js';
import admin from '../controllers/users.admin.controller.js';

export default (app) => {
  /**
   * Admin Users
   */

  // List all users
  app.route('/api/admin/users').get(passport.authenticate('jwt', { session: false }), policy.isAllowed, admin.list);

  // Stats (registered before :userId so 'stats' is never read as an id)
  app.route('/api/admin/users/stats').get(passport.authenticate('jwt', { session: false }), policy.isAllowed, admin.stats);

  // Users page
  app.route('/api/admin/users/page/:userPage').get(passport.authenticate('jwt', { session: false }), policy.isAllowed, admin.list);

  // Single user routes
  app
    .route('/api/admin/users/:userId')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(admin.get)
    .put(admin.update)
    .delete(admin.remove);

  // Bind param middleware
  app.param('userId', admin.userByID);
  app.param('userPage', admin.userByPage);
};
