/**
 * Module dependencies
 */
import passport from 'passport';

import model from '../../../lib/middlewares/model.js';
import policy from '../../../lib/middlewares/policy.js';
import organizations from '../controllers/organizations.controller.js';
import members from '../controllers/organizations.membership.controller.js';
import membershipSchema from '../models/organizations.membership.schema.js';

/**
 * Routes
 */
export default (app) => {
  // Member routes (nested under organization)
  app
    .route('/api/organizations/:organizationId/members')
    .all(passport.authenticate('jwt', { session: false }), organizations.loadMembership, policy.isAllowed)
    .get(members.list);

  app
    .route('/api/organizations/:organizationId/members/invite')
    .all(passport.authenticate('jwt', { session: false }), organizations.loadMembership, policy.isAllowed)
    .post(model.isValid(membershipSchema.MembershipInvite), members.invite);

  app
    .route('/api/organizations/:organizationId/members/:memberId')
    .all(passport.authenticate('jwt', { session: false }), organizations.loadMembership, policy.isAllowed)
    .put(model.isValid(membershipSchema.MembershipUpdate), members.updateRole)
    .delete(members.remove);

  // Bind param middleware
  app.param('organizationId', organizations.organizationByID);
  app.param('memberId', members.memberByID);
};
