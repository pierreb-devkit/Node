/**
 * Module dependencies
 */
import passport from 'passport';

import policy from '../../../lib/middlewares/policy.js';
import limiters from '../../../lib/middlewares/rateLimiter.js';
import uploads from '../controllers/uploads.controller.js';

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

  // public image access (guest-readable, no JWT required). Rate-limited because
  // it runs the full sharp pipeline on every guest request (CPU-exhaustion DoS).
  app
    .route('/api/uploads/images/:imageName')
    .all(policy.isAllowed)
    .get(limiters.publicImage, uploads.getSharp);

  // Finish by binding the task middleware
  app.param('uploadName', uploads.uploadByName);
  app.param('imageName', uploads.uploadByImageName);
};
