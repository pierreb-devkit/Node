/**
 * Module dependencies
 */
import passport from 'passport';

import limiters from '../../../lib/middlewares/rateLimiter.js';
import model from '../../../lib/middlewares/model.js';
import policy from '../../../lib/middlewares/policy.js';
import invitations from '../controllers/auth.invitation.controller.js';
import InvitationSchema from '../models/auth.invitation.schema.js';

/**
 * Register signup-invitation routes.
 * @param {Object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  // Public — verify a token so the signup page can show "invited" + prefill email
  app.route('/api/auth/invitations/verify/:token').get(limiters.auth, invitations.verify);

  // Admin — list + create
  app
    .route('/api/auth/invitations')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(invitations.list)
    .post(model.isValid(InvitationSchema.Invitation), invitations.create);

  // Admin — revoke
  app
    .route('/api/auth/invitations/:invitationId')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .delete(invitations.remove);

  app.param('invitationId', invitations.invitationByID);
};
