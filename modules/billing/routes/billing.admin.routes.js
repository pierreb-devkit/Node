/**
 * Module dependencies
 */
import passport from 'passport';

import policy from '../../../lib/middlewares/policy.js';
import model from '../../../lib/middlewares/model.js';
import billingAdmin from '../controllers/billing.admin.controller.js';
import {
  AdminRefundRequest,
  AdminBumpPlanRequest,
  AdminWebhookReplayRequest,
} from '../models/billing.subscription.schema.js';

/**
 * Routes
 * @param {Object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  app
    .route('/api/admin/billing/refund')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .post(model.isValid(AdminRefundRequest), billingAdmin.adminRefundCharge);

  app
    .route('/api/admin/billing/plans/bump')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .patch(model.isValid(AdminBumpPlanRequest), billingAdmin.adminBumpPlan);

  // Admin toolkit — diagnostic + ops endpoints

  app
    .route('/api/admin/billing/customer/:orgId')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(billingAdmin.adminGetCustomerStatus);

  app
    .route('/api/admin/billing/sync/:orgId')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .post(billingAdmin.adminSyncFromStripe);

  app
    .route('/api/admin/billing/webhook/replay')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .post(model.isValid(AdminWebhookReplayRequest), billingAdmin.adminReplayWebhook);

  app
    .route('/api/admin/billing/dead-letters')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(billingAdmin.adminListDeadLetters);

  app
    .route('/api/admin/billing/dead-letters/:eventId')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .delete(billingAdmin.adminPurgeDeadLetter);

  app
    .route('/api/admin/billing/cancel/:orgId')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .post(billingAdmin.adminCancelSubscription);
};
