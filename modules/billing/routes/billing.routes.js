/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import passport from 'passport';

import model from '../../../lib/middlewares/model.js';
import policy from '../../../lib/middlewares/policy.js';
import organization from '../../organizations/middlewares/organizations.middleware.js';
import billingSchema from '../models/billing.subscription.schema.js';
import billingPlans from '../controllers/billing.plans.controller.js';
import billing from '../controllers/billing.controller.js';
import attachUsageContext from '../middlewares/billing.attachUsageContext.js';

/**
 * @desc Register billing routes
 * @param {Object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  const billingGuards = [
    passport.authenticate('jwt', { session: false }),
    organization.resolveOrganization,
    ...(config.billing?.meterMode === true && config.billing?.attachUsageHeader === true
      ? [attachUsageContext]
      : []),
    policy.isAllowed,
  ];

  // plans (public)
  app.route('/api/billing/plans').get(billingPlans.getPlans);

  // checkout
  app
    .route('/api/billing/checkout')
    .all(...billingGuards)
    .post(model.isValid(billingSchema.CheckoutRequest), billing.checkout);

  // portal
  app
    .route('/api/billing/portal')
    .all(...billingGuards)
    .post(model.isValid(billingSchema.PortalRequest), billing.portal);

  // subscription
  app
    .route('/api/billing/subscription')
    .all(...billingGuards)
    .get(billing.getSubscription);

  // usage
  app
    .route('/api/billing/usage')
    .all(...billingGuards)
    .get(billing.getUsage);

  // extras checkout (one-time pack purchase)
  app
    .route('/api/billing/extras/checkout')
    .all(...billingGuards)
    .post(model.isValid(billingSchema.ExtrasCheckoutRequest), billing.extrasCheckout);

  // extras balance
  app
    .route('/api/billing/extras/balance')
    .all(...billingGuards)
    .get(billing.extrasBalance);

  // extras ledger (paginated: ?page=1&limit=20)
  app
    .route('/api/billing/extras/ledger')
    .all(...billingGuards)
    .get(billing.extrasLedger);
};
