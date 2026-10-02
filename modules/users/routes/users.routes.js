/**
 * Module dependencies
 */
import passport from 'passport';

import multer from '../../../lib/services/multer.js';
import model from '../../../lib/middlewares/model.js';
import config from '../../../config/index.js';
import policy from '../../../lib/middlewares/policy.js';
import limiters from '../../../lib/middlewares/rateLimiter.js';
import usersSchema from '../models/users.schema.js';
import users from '../controllers/users.account.controller.js';
import usersImage from '../controllers/users.images.controller.js';
import authPassword from '../../auth/controllers/auth.password.controller.js';

export default (app) => {
  app.route('/api/users/stats').all(policy.isAllowed).get(users.stats);

  // One-click unsubscribe (#4162) — public, token-authorized (RFC 8058), no
  // passport/policy middleware. Rate-limited with the SAME profile as the
  // other public, token-in-path auth routes (reset, verify-email) — reusing
  // `limiters.auth` rather than inventing a new rate-limit profile for this
  // one route.
  app.route('/api/users/unsubscribe/:token').post(limiters.auth, users.unsubscribe);

  app.route('/api/users/me').get(passport.authenticate('jwt', { session: false }), policy.isAllowed, users.me);

  app.route('/api/users/terms').get(passport.authenticate('jwt', { session: false }), policy.isAllowed, users.terms);

  app
    .route('/api/users')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .put(model.isValid(usersSchema.UserUpdate), users.update)
    .delete(users.remove);

  app.route('/api/users/password').post(passport.authenticate('jwt', { session: false }), policy.isAllowed, authPassword.updatePassword);

  app
    .route('/api/users/avatar')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .post(multer.create(config.uploads.avatar), usersImage.updateAvatar)
    .delete(usersImage.removeAvatar);
};
