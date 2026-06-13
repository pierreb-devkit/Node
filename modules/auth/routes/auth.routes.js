/**
 * Module dependencies
 */
import passport from 'passport';

import limiters from '../../../lib/middlewares/rateLimiter.js';
import model from '../../../lib/middlewares/model.js';
import policy from '../../../lib/middlewares/policy.js';
import UsersSchema from '../../users/models/users.schema.js';
import auth from '../controllers/auth.controller.js';
import authPassword from '../controllers/auth.password.controller.js';
// TODO(P9, pierreb-devkit/Node#3815): Remove these two imports and the four routes
// below ONLY after (a) the downstream consumer has absorbed Vue P6 via /update-stack AND
// (b) Vue auth.store `verifyInvite` is repointed to the canonical
// /api/invitations/verify/:token (Vue pre-P9 fix PR) — it still calls the alias.
// Deprecation alias only — the invitations feature lives in modules/invitations.
// This block MUST stay here (before the greedy `/api/auth/:strategy` wildcard) so
// the legacy `/api/auth/invitations*` paths the Vue admin store still calls keep
// working; it points at the MOVED controller. Canonical mount: /api/invitations
// (modules/invitations/routes/invitations.routes.js).
// INTENTIONAL core→optional import: temporary coupling until P9 removes these routes.
import invitations from '../../invitations/controllers/invitations.controller.js';
import InvitationSchema from '../../invitations/models/invitations.schema.js';

/**
 * Register authentication routes on the Express application.
 * @param {Object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  const authLimiter = limiters.auth;

  // Signup invitations — DEPRECATION ALIAS for the canonical /api/invitations mount
  // (modules/invitations). MUST be declared before the greedy `/api/auth/:strategy`
  // wildcard below, which would otherwise capture `/api/auth/invitations`. A separate
  // glob-loaded module cannot guarantee it loads before that wildcard, so the alias
  // stays here, pointing at the MOVED controller. The `invitationId` param callback is
  // registered once (app-global) by the canonical invitations.routes.js, so it resolves
  // for this alias route too — no need (and harmful: double DB lookup) to re-register it.
  app.route('/api/auth/invitations/verify/:token').get(authLimiter, invitations.verify);
  app
    .route('/api/auth/invitations')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(invitations.list)
    .post(model.isValid(InvitationSchema.Invitation), invitations.create);
  app
    .route('/api/auth/invitations/:invitationId')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .delete(invitations.remove);
  app
    .route('/api/auth/invitations/:invitationId/resend')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .post(invitations.resend);

  // Auth config — optional JWT: public fields for everyone, org details for authenticated users
  /**
   * @desc Middleware that optionally authenticates via JWT, attaching user if valid but allowing unauthenticated requests.
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   * @returns {void}
   */
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
  // Signout: intentionally no JWT middleware — must clear the cookie even if the
  // token is expired/invalid/missing so the client cannot get silently re-logged in.
  app.route('/api/auth/signout').post(authLimiter, auth.signout);

  // Email verification
  app.route('/api/auth/verify-email/:token').post(authLimiter, auth.verifyEmail);
  app.route('/api/auth/resend-verification').post(
    authLimiter,
    passport.authenticate('jwt', { session: false }),
    auth.resendVerification,
  );

  // Jwt reset token
  app.route('/api/auth/token').get(passport.authenticate('jwt', { session: false }), auth.token);

  // Setting the oauth routes
  app.route('/api/auth/:strategy').get(auth.oauthCall);
  app.route('/api/auth/:strategy/callback').get(auth.oauthCallback);
  app.route('/api/auth/:strategy/callback').post(auth.oauthCallback); // specific for apple call back
};
