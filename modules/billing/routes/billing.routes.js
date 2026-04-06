/**
 * Module dependencies
 */
import passport from 'passport';

import model from '../../../lib/middlewares/model.js';
import policy from '../../../lib/middlewares/policy.js';
import organization from '../../organizations/middlewares/organizations.middleware.js';
import billingSchema from '../models/billing.subscription.schema.js';
import billingPlans from '../controllers/billing.plans.controller.js';
import billing from '../controllers/billing.controller.js';

/**
 * @desc Register billing routes
 * @param {Object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  // plans (public)
  app.route('/api/billing/plans').get(billingPlans.getPlans);

  // checkout
  app
    .route('/api/billing/checkout')
    .all(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed)
    .post(model.isValid(billingSchema.CheckoutRequest), billing.checkout);

  // portal
  app
    .route('/api/billing/portal')
    .all(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed)
    .post(model.isValid(billingSchema.PortalRequest), billing.portal);

  // subscription
  app
    .route('/api/billing/subscription')
    .all(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed)
    .get(billing.getSubscription);

  // usage
  app
    .route('/api/billing/usage')
    .all(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed)
    .get(billing.getUsage);
};
