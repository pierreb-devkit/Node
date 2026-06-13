/**
 * Module dependencies
 */
import passport from 'passport';

import limiters from '../../../lib/middlewares/rateLimiter.js';
import model from '../../../lib/middlewares/model.js';
import policy from '../../../lib/middlewares/policy.js';
import invitations from '../controllers/invitations.controller.js';
import InvitationSchema from '../models/invitations.schema.js';

/**
 * Register the canonical signup-invitation routes on the Express application.
 * Public verify + admin CRUD, mounted at `/api/invitations`. The legacy
 * `/api/auth/invitations*` alias is kept in auth.routes.js (before the greedy
 * `/api/auth/:strategy` wildcard) and points at this same moved controller.
 * @param {Object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  const authLimiter = limiters.auth;

  // Public: report whether a token is a valid invite (+ prefill email).
  app.route('/api/invitations/verify/:token').get(authLimiter, invitations.verify);

  // Param loader for :invitationId — anchored before the routes that use it
  // (app.param is global regardless of position, but keeping it here is the
  // house convention and avoids a future reader missing it for a new route).
  app.param('invitationId', invitations.invitationByID);

  // Admin CRUD — list + create.
  app
    .route('/api/invitations')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(invitations.list)
    .post(model.isValid(InvitationSchema.Invitation), invitations.create);

  // Admin CRUD — revoke.
  app
    .route('/api/invitations/:invitationId')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .delete(invitations.remove);

  // Admin — re-send the invitation email (pending invites only, existing token).
  app
    .route('/api/invitations/:invitationId/resend')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .post(invitations.resend);
};
