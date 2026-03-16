/**
 * Module dependencies
 */
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';

import responses from '../../../lib/helpers/responses.js';

/**
 * Returns Express middleware that gates access based on subscription plan.
 * This middleware is orthogonal to CASL — CASL gates by role, requirePlan
 * gates by subscription plan.
 *
 * Expects `req.organization` to be set by resolveOrganization upstream.
 *
 * @param {...string} plans - One or more allowed plan identifiers.
 * @returns {Function} Express middleware function.
 */
function requirePlan(...plans) {
  return async function requirePlanMiddleware(req, res, next) {
    if (!req.organization) {
      return responses.error(res, 403, 'Forbidden', 'Organization context is required to check subscription plan')();
    }

    try {
      const subscription = await SubscriptionRepository.findByOrganization(req.organization._id);
      const currentPlan = subscription?.plan || 'free';

      if (plans.includes(currentPlan)) return next();

      return responses.error(res, 403, 'Forbidden', 'Your current plan does not allow access to this resource')({
        type: 'PLAN_REQUIRED',
        requiredPlans: plans,
        currentPlan,
      });
    } catch (err) {
      return next(err);
    }
  };
}

export default requirePlan;
