/**
 * Module dependencies
 */
import passport from 'passport';

import policy from '../../../lib/middlewares/policy.js';
import limiters from '../../../lib/middlewares/rateLimiter.js';
import uploads from '../controllers/uploads.controller.js';
import optionalAuth from '../middlewares/uploads.optionalAuth.js';

/**
 * Register uploads routes.
 * @param {import('express').Application} app - Express app instance
 * @returns {void}
 */
export default (app) => {
  // classic crud — ownership is enforced by CASL conditions in isAllowed
  app
    .route('/api/uploads/:uploadName')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(uploads.get)
    .delete(uploads.remove); // delete

  // image access: login optional. Guests read only guest-readable kinds
  // (`guestRead: true`); a logged-in user also reads their own / their org's.
  // Rate-limited because it runs the full sharp pipeline on every guest request
  // (CPU-exhaustion DoS).
  app
    .route('/api/uploads/images/:imageName')
    .all(optionalAuth, policy.isAllowed)
    .get(limiters.publicImage, uploads.getSharp);

  // Finish by binding the task middleware
  app.param('uploadName', uploads.uploadByName);
  app.param('imageName', uploads.uploadByImageName);
};
