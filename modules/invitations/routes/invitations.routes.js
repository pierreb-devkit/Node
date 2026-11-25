/**
 * Module dependencies
 */
import passport from 'passport';

import limiters from '../../../lib/middlewares/rateLimiter.js';
import model from '../../../lib/middlewares/model.js';
import policy from '../../../lib/middlewares/policy.js';
import invitations from '../controllers/invitations.controller.js';
import organizationsMiddleware from '../../organizations/middlewares/organizations.middleware.js';
import InvitationSchema from '../models/invitations.schema.js';

/**
 * Register the canonical signup-invitation routes on the Express application.
 * Public verify + admin CRUD, mounted at `/api/invitations`.
 * @param {Object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  const authLimiter = limiters.auth;
  // #3945: create is no longer admin-only-by-trust once `invitations.userFacing`
  // widens it — rate-limit it the same way verify/:token already is (mass-create
  // is a DB-bloat / outbound-email-spam abuse surface). Passthrough no-op if the
  // `invitationsCreate` profile is absent from config (mirrors every other named
  // limiter in this stack).
  const createLimiter = limiters.invitationsCreate;

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
    .post(createLimiter, model.isValid(InvitationSchema.Invitation), invitations.create);

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

  // Organization invitations — an org owner/admin (or platform admin) invites an email
  // INTO the organization, and lists / revokes / resends the org's pending invites.
  // `:organizationId` is loaded by the organizations module's global param loader (404
  // when missing), then its membership loader sets req.membership. The rights gate is
  // requireOrganizationManager, not CASL (see its docblock).
  const orgGate = [passport.authenticate('jwt', { session: false }), organizationsMiddleware.loadMembership, invitations.requireOrganizationManager];
  app
    .route('/api/organizations/:organizationId/invitations')
    .all(...orgGate)
    .get(invitations.organizationList)
    .post(createLimiter, model.isValid(InvitationSchema.OrganizationInvitation), invitations.organizationCreate);

  app
    .route('/api/organizations/:organizationId/invitations/:invitationId')
    .all(...orgGate, invitations.invitationInOrganization)
    .delete(invitations.remove);

  // Resend sends an email too — same limiter as create.
  app
    .route('/api/organizations/:organizationId/invitations/:invitationId/resend')
    .all(...orgGate, invitations.invitationInOrganization)
    .post(createLimiter, invitations.organizationResend);
};
