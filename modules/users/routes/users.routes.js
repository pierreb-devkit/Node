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
  // passport/policy middleware. Its OWN rate-limit profile (`unsubscribe`, see
  // users.development.config.js / production.config.js) — NOT `limiters.auth`:
  // these POSTs come from mail providers' shared egress IPs, so auth's
  // 10/15min-per-IP cap would lock out genuine recipients after a handful of
  // sends from the same provider.
  app.route('/api/users/unsubscribe/:token').post(limiters.unsubscribe, users.unsubscribe);

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
