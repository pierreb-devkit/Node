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
  // GET  → list members. POST → owner/admin adds a user (creates a PENDING owner_add
  //   membership the invited user must accept). Both resolve to the `Membership`
  //   CASL subject via the `/members` path segment (policy.isAllowed).
  app
    .route('/api/organizations/:organizationId/members')
    .all(passport.authenticate('jwt', { session: false }), organizations.loadMembership, policy.isAllowed)
    .get(members.list)
    .post(model.isValid(membershipSchema.MembershipAdd), members.addMember);

  // User-directory lookup by EXACT email (owner/admin add-member affordance, P5b).
  // Registered BEFORE /members/:memberId so 'search' is not captured as :memberId.
  app
    .route('/api/organizations/:organizationId/members/search')
    .all(passport.authenticate('jwt', { session: false }), organizations.loadMembership, policy.isAllowed)
    .get(members.findUserByEmail);

  app
    .route('/api/organizations/:organizationId/members/:memberId')
    .all(passport.authenticate('jwt', { session: false }), organizations.loadMembership, policy.isAllowed)
    .put(model.isValid(membershipSchema.MembershipUpdate), members.updateRole)
    .delete(members.remove);

  // Bind param middleware
  app.param('memberId', members.memberByID);
};
