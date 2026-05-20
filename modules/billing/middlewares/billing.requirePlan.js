/**
 * Module dependencies
 */
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';

/**
 * Statuses considered "active" for plan-entitlement checks.
 * canceled / past_due / unpaid / incomplete fall back to 'free' resolution.
 * @type {Set<string>}
 */
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

/**
 * Returns Express middleware that gates access based on subscription plan AND status.
 * Orthogonal to CASL — CASL gates by role, requirePlan gates by subscription plan.
 *
 * A plan is only effective when subscription.status ∈ {active, trialing}.
 * canceled / past_due / unpaid / incomplete are treated as 'free'.
 *
 * Response shape on deny matches the downstream trawl_node contract (top-level errorCode):
 *   { type: 'error', message: 'Forbidden', code: 403, status: 403,
 *     errorCode: 'PLAN_REQUIRED', description, requiredPlans: string[], currentPlan: string }
 *
 * Expects `req.organization` to be set by resolveOrganization upstream.
 *
 * @param {...string} plans - One or more allowed plan identifiers.
 * @returns {Function} Express middleware function.
 */
function requirePlan(...plans) {
  return async function requirePlanMiddleware(req, res, next) {
    if (!req.organization) {
      return res.status(403).json({
        type: 'error',
        message: 'Forbidden',
        code: 403,
        status: 403,
        errorCode: 'ORG_CONTEXT_REQUIRED',
        description: 'Organization context is required to check subscription plan',
      });
    }

    try {
      const subscription = await SubscriptionRepository.findByOrganization(req.organization._id);
      const isEffective = subscription && ACTIVE_STATUSES.has(subscription.status);
      const currentPlan = isEffective ? subscription.plan : 'free';

      if (plans.includes(currentPlan)) return next();

      return res.status(403).json({
        type: 'error',
        message: 'Forbidden',
        code: 403,
        status: 403,
        errorCode: 'PLAN_REQUIRED',
        description: 'Your current plan does not allow access to this resource',
        requiredPlans: plans,
        currentPlan,
      });
    } catch (err) {
      return next(err);
    }
  };
}

export default requirePlan;
