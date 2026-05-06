/**
 * Module dependencies
 */
import passport from 'passport';

import policy from '../../../lib/middlewares/policy.js';
import model from '../../../lib/middlewares/model.js';
import billingAdmin from '../controllers/billing.admin.controller.js';
import { AdminRefundRequest, AdminBumpPlanRequest } from '../models/billing.subscription.schema.js';

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
};
