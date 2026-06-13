/**
 * Module dependencies
 */
import passport from 'passport';

import limiters from '../../../lib/middlewares/rateLimiter.js';
import policy from '../../../lib/middlewares/policy.js';
import organizations from '../controllers/organizations.controller.js';
import membershipRequests from '../controllers/organizations.membershipRequest.controller.js';

/**
 * Register membership request routes on the Express application.
 * @param {Object} app - Express application instance
 */
export default (app) => {
  // User's own pending OWNER_ADD invitations to accept (P5b "pending invitations"
  // list). Auth-only: the invitee is not yet an org member, so NO org-membership /
  // CASL check — and registered BEFORE /:membershipId so 'mine' isn't captured as one.
  app
    .route('/api/membership-requests/mine/pending')
    .all(passport.authenticate('jwt', { session: false }))
    .get(membershipRequests.listMinePending);

  // User's own membership JOIN requests (initiated by the user, awaiting approval)
  app
    .route('/api/membership-requests/mine')
    .all(passport.authenticate('jwt', { session: false }))
    .get(membershipRequests.listMine);

  // The INVITED USER accepts a pending owner_add membership (consent activation).
  // Auth-only — the consent gate (membership is a PENDING owner_add AND belongs to
  // the caller) is enforced in the service, not via org-membership CASL. The owner
  // can NEVER reach this for someone else's invite.
  app
    .route('/api/membership-requests/:membershipId/accept')
    .all(passport.authenticate('jwt', { session: false }))
    .put(membershipRequests.accept);

  // The INVITED USER declines a pending owner_add membership (deletes the row so
  // they can be re-invited). Auth-only — same consent gate as accept, enforced in
  // the service. Registered AFTER /mine and /mine/pending so those literals are
  // never captured as a :membershipId. NOTE: there is intentionally no app.param
  // for :membershipId — the controller reads req.params.membershipId raw, exactly
  // like accept does.
  app
    .route('/api/membership-requests/:membershipId')
    .all(passport.authenticate('jwt', { session: false }))
    .delete(membershipRequests.decline);

  // Create a request to join an organization / list pending requests for an organization
  app
    .route('/api/organizations/:organizationId/requests')
    .all(passport.authenticate('jwt', { session: false }))
    .post(limiters.api, organizations.loadMembership, policy.isAllowed, membershipRequests.create)
    .get(organizations.loadMembership, membershipRequests.listPending);

  // Approve a membership request
  app
    .route('/api/organizations/:organizationId/requests/:membershipRequestId/approve')
    .all(passport.authenticate('jwt', { session: false }), organizations.loadMembership, policy.isAllowed)
    .put(membershipRequests.approve);

  // Reject a membership request
  app
    .route('/api/organizations/:organizationId/requests/:membershipRequestId/reject')
    .all(passport.authenticate('jwt', { session: false }), organizations.loadMembership, policy.isAllowed)
    .put(membershipRequests.reject);

  // Bind param middleware
  app.param('membershipRequestId', membershipRequests.requestByID);
};
