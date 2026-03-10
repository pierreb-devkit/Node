/**
 * Module dependencies
 */
import passport from 'passport';

import model from '../../../lib/middlewares/model.js';
import policy from '../../../lib/middlewares/policy.js';
import organizations from '../controllers/organizations.controller.js';
import organizationsSchema from '../models/organizations.schema.js';

/**
 * Routes
 */
export default (app) => {
  // Organization CRUD
  app
    .route('/api/organizations')
    .all(passport.authenticate('jwt', { session: false }))
    .get(organizations.list)
    .post(policy.isAllowed, model.isValid(organizationsSchema.Organization), organizations.create);

  app
    .route('/api/organizations/:organizationId')
    .all(passport.authenticate('jwt', { session: false }), organizations.loadMembership, policy.isAllowed)
    .get(organizations.get)
    .put(model.isValid(organizationsSchema.OrganizationUpdate), organizations.update)
    .delete(organizations.remove);

  // Organization switch
  app
    .route('/api/organizations/:organizationId/switch')
    .all(passport.authenticate('jwt', { session: false }))
    .post(organizations.switchOrganization);

  // Platform admin routes
  app
    .route('/api/admin/organizations')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(organizations.adminList);

  app
    .route('/api/admin/organizations/:organizationId')
    .all(passport.authenticate('jwt', { session: false }), organizations.loadMembership, policy.isAllowed)
    .get(organizations.get)
    .delete(organizations.remove);

  // Bind param middleware
  app.param('organizationId', organizations.organizationByID);
};
