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
