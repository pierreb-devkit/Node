/**
 * Module dependencies
 */
import passport from 'passport';

import limiters from '../../../lib/middlewares/rateLimiter.js';
import policy from '../../../lib/middlewares/policy.js';
import organizations from '../controllers/organizations.controller.js';
import membershipRequests from '../controllers/organizations.membershipRequest.controller.js';

/**
 * Routes
 */
export default (app) => {
  // User's own membership requests
  app
    .route('/api/membership-requests/mine')
    .all(passport.authenticate('jwt', { session: false }))
    .get(membershipRequests.listMine);

  // Create a request to join an organization / list pending requests for an organization
  app
    .route('/api/organizations/:organizationId/requests')
    .all(passport.authenticate('jwt', { session: false }))
    .post(limiters.api, organizations.loadMembership, policy.isAllowed, membershipRequests.create)
    .get(organizations.loadMembership, policy.isAllowed, membershipRequests.listPending);

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

  // Invite a user to an organization (owner/admin)
  app
    .route('/api/organizations/:organizationId/invites')
    .all(passport.authenticate('jwt', { session: false }), organizations.loadMembership, policy.isAllowed)
    .post(membershipRequests.invite);

  // Get invite details
  app
    .route('/api/invites/:token')
    .all(passport.authenticate('jwt', { session: false }))
    .get(membershipRequests.getInvite);

  // Accept an invite
  app
    .route('/api/invites/:token/accept')
    .all(passport.authenticate('jwt', { session: false }))
    .post(membershipRequests.acceptInvite);

  // Bind param middleware
  app.param('membershipRequestId', membershipRequests.requestByID);
};
