/**
 * Module dependencies
 */
import passport from 'passport';

import policy from '../../../lib/middlewares/policy.js';
import uploads from '../controllers/uploads.controller.js';

/**
 * Routes
 */
export default (app) => {
  // classic crud
  app
    .route('/api/uploads/:uploadName')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(uploads.get)
    .delete(policy.isOwner, uploads.remove); // delete

  // public image access (guest-readable, no JWT required)
  app
    .route('/api/uploads/images/:imageName')
    .all(policy.isAllowed)
    .get(uploads.getSharp);

  // Finish by binding the task middleware
  app.param('uploadName', uploads.uploadByName);
  app.param('imageName', uploads.uploadByImageName);
};
