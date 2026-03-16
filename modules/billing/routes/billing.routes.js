/**
 * Module dependencies
 */
import billing from '../controllers/billing.plans.controller.js';

/**
 * @desc Register billing routes
 * @param {Object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  // plans (public)
  app.route('/api/billing/plans').get(billing.getPlans);
};
