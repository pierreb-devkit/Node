/**
 * Module dependencies
 */
import billing from '../controllers/billing.plans.controller.js';

/**
 * Routes
 */
export default (app) => {
  // plans (public)
  app.route('/api/billing/plans').get(billing.getPlans);
};
