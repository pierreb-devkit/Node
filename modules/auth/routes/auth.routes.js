/**
 * Module dependencies
 */
import passport from 'passport';
import rateLimit from 'express-rate-limit';

import config from '../../../config/index.js';
import model from '../../../lib/middlewares/model.js';
import UsersSchema from '../../users/models/user.schema.js';
import auth from '../controllers/auth.controller.js';
import authPassword from '../controllers/auth.password.controller.js';

export default (app) => {
  const authLimiter = rateLimit(config.rateLimit.auth);

  // Public auth config (no authentication required, rate-limited)
  app.route('/api/auth/config').get(authLimiter, auth.getConfig);

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
