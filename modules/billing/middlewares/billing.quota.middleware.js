/**
 * Module dependencies
 */
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';
import BillingUsageService from '../services/billing.usage.service.js';

import config from '../../../config/index.js';
import responses from '../../../lib/helpers/responses.js';

/**
 * Returns Express middleware that gates access based on plan quotas.
 * Reads limits from `config.billing.quotas[plan][resource][action]` and
 * compares against the current month's usage via BillingUsageService.
 *
 * Expects `req.organization` to be set by resolveOrganization upstream.
 *
 * @param {string} resource - The quota resource name (e.g. 'scraps').
 * @param {string} action - The quota action name (e.g. 'create', 'execute').
 * @returns {Function} Express middleware function.
 */
function requireQuota(resource, action) {
  return async function requireQuotaMiddleware(req, res, next) {
    if (!req.organization) {
      return responses.error(res, 403, 'Forbidden', 'Organization context is required to check quota')();
    }

    try {
      // Determine current plan — default to free when no subscription or past_due
      const subscription = await SubscriptionRepository.findByOrganization(req.organization._id);
      const plan = (!subscription || subscription.status === 'past_due') ? 'free' : (subscription.plan || 'free');

      // Look up quota limit from config
      const quotas = config.billing?.quotas;
      const limit = quotas?.[plan]?.[resource]?.[action];

      // If no quota is configured for this plan/resource/action, allow through
      if (limit === undefined || limit === null) return next();

      // Infinity means unlimited — skip usage check
      if (limit === Infinity) return next();

      // Check current usage
      const usage = await BillingUsageService.get(req.organization._id.toString());
      const counterKey = `${resource}.${action}`;
      const current = usage.counters[counterKey] || 0;

      if (current >= limit) {
        return res.status(429).json({
          type: 'QUOTA_EXCEEDED',
          resource,
          action,
          limit,
          current,
          upgradeUrl: config.billing?.upgradeUrl || '/billing/plans',
        });
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export default requireQuota;
