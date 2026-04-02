/**
 * Module dependencies
 */
import passport from 'passport';
import policy from '../../../lib/middlewares/policy.js';
import home from '../controllers/home.controller.js';

/**
 * Optional JWT — enriches req.user if token is valid, passes through otherwise.
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 * @returns {void}
 */
const optionalAuth = (req, res, next) => {
  passport.authenticate('jwt', { session: false }, (_err, user) => {
    if (user) req.user = user;
    next();
  })(req, res, next);
};

/**
 * Register home routes.
 * @param {import('express').Application} app - Express app instance
 * @returns {void}
 */
export default (app) => {
  // health check — public, enriched response for admins
  app.route('/api/health').get(optionalAuth, home.health);
  // changelogs
  app.route('/api/home/releases').all(policy.isAllowed).get(home.releases);
  // changelogs
  app.route('/api/home/changelogs').all(policy.isAllowed).get(home.changelogs);
  // changelogs
  app.route('/api/home/team').all(policy.isAllowed).get(home.team);
  // markdown files
  app.route('/api/home/pages/:name').all(policy.isAllowed).get(home.page);
  // readiness check — admin only (JWT + CASL)
  app.route('/api/admin/readiness').all(passport.authenticate('jwt', { session: false }), policy.isAllowed).get(home.readiness);

  // Finish by binding the task middleware
  app.param('name', home.pageByName);
};
