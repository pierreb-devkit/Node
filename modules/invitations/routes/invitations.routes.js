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

  app.param('invitationId', invitations.invitationByID);
};
