/**
 * Module dependencies
 */
import passport from 'passport';

import limiters from '../../../lib/middlewares/rateLimiter.js';
import model from '../../../lib/middlewares/model.js';
import UsersSchema from '../../users/models/users.schema.js';
import auth from '../controllers/auth.controller.js';
import authPassword from '../controllers/auth.password.controller.js';

/**
 * Register authentication routes on the Express application.
 * @param {Object} app - Express application instance
 */
export default (app) => {
  const authLimiter = limiters.auth;

  // Auth config — optional JWT: public fields for everyone, org details for authenticated users
  const optionalJwt = (req, res, next) => {
    passport.authenticate('jwt', { session: false }, (err, user) => {
      if (user) req.user = user;
      next();
    })(req, res, next);
  };
  app.route('/api/auth/config').get(authLimiter, optionalJwt, auth.getConfig);

  // Setting up the users password api
  app.route('/api/auth/forgot').post(authLimiter, authPassword.forgot);
  app.route('/api/auth/reset/:token').get(authLimiter, authPassword.validateResetToken);
  app.route('/api/auth/reset').post(authLimiter, authPassword.reset);

  // Setting up the users authentication api
  app.route('/api/auth/signup').post(authLimiter, model.isValid(UsersSchema.User), auth.signup);
  app.route('/api/auth/signin').post(authLimiter, auth.signinAuthenticate, auth.signin);

  // Email verification
  app.route('/api/auth/verify-email/:token').post(authLimiter, auth.verifyEmail);
  app.route('/api/auth/resend-verification').post(passport.authenticate('jwt', { session: false }), auth.resendVerification);

  // Jwt reset token
  app.route('/api/auth/token').get(passport.authenticate('jwt', { session: false }), auth.token);

  // Setting the oauth routes
  app.route('/api/auth/:strategy').get(auth.oauthCall);
  app.route('/api/auth/:strategy/callback').get(auth.oauthCallback);
  app.route('/api/auth/:strategy/callback').post(auth.oauthCallback); // specific for apple call back
};
