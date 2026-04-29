/**
 * Module dependencies
 */
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';
import BillingUsageService from '../services/billing.usage.service.js';
import BillingExtraBalanceRepository from '../repositories/billing.extraBalance.repository.js';

import { activeStatuses } from '../lib/constants.js';
import config from '../../../config/index.js';
import responses from '../../../lib/helpers/responses.js';

/**
 * Returns Express middleware that gates access based on plan quotas.
 *
 * Dual mode:
 * - When `config.billing.meterMode === false` (default): legacy quota logic.
 *   Reads limits from `config.billing.quotas[plan][resource][action]` and
 *   compares against the current month's usage via BillingUsageService.
 *   When no quota is configured or limit is Infinity, the request is allowed.
 *
 * - When `config.billing.meterMode === true`: meter quota gate.
 *   Computes `(meterQuota - meterUsed) + extrasBalance`. Returns 402 when <= 0,
 *   including pack purchase info for the client. Falls through to next() otherwise.
 *
 * Expects `req.organization` to be set by resolveOrganization upstream.
 *
 * @param {string} resource - The quota resource name (e.g. 'scraps'). Used in legacy mode.
 * @param {string} action - The quota action name (e.g. 'create', 'execute'). Used in legacy mode.
 * @returns {Function} Express middleware function.
 */
function requireQuota(resource, action) {
  /**
   * Enforce quota for a resource/action and block requests when limit is reached.
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next callback.
   * @returns {Promise<void>} Resolves when middleware handling completes.
   */
  return async function requireQuotaMiddleware(req, res, next) {
    if (!req.organization) {
      return responses.error(res, 403, 'Forbidden', 'Organization context is required to check quota')();
    }

    try {
      // ── Meter mode (meterMode: true) ──────────────────────────────────────
      if (config.billing?.meterMode === true) {
        const orgId = req.organization._id.toString();
        const usage = await BillingUsageService.getMeter(orgId);
        const extrasBalance = await BillingExtraBalanceRepository.getBalance(orgId);

        const meterUsed = usage?.meterUsed ?? 0;
        const meterQuota = usage?.meterQuota ?? 0;
        const remaining = (meterQuota - meterUsed) + extrasBalance;

        if (remaining <= 0) {
          return responses.error(res, 402, 'Payment Required', 'Meter exhausted')({
            type: 'METER_EXHAUSTED',
            meterUsed,
            meterQuota,
            extrasRemaining: extrasBalance,
            packsAvailable: config.billing?.packs ?? [],
            upgradeUrl: config.billing?.upgradeUrl ?? '/billing/plans',
          });
        }

        return next();
      }

      // ── Legacy mode (meterMode: false, default) ───────────────────────────
      // Determine current plan — default to free when subscription is missing or inactive
      const subscription = await SubscriptionRepository.findByOrganization(req.organization._id);
      const plan = (!subscription || !activeStatuses.includes(subscription.status)) ? 'free' : (subscription.plan || 'free');

      // Look up quota limit from config
      const quotas = config.billing?.quotas;
      const limit = quotas?.[plan]?.[resource]?.[action];

      // If no quota is configured for this plan/resource/action, allow through
      if (limit === undefined || limit === null) return next();

      // Infinity means unlimited — skip usage check
      if (limit === Infinity) return next();

      // Check current usage
      const usage = await BillingUsageService.get(req.organization._id.toString());
      const counterKey = `${resource}_${action}`;
      const current = usage.counters[counterKey] || 0;

      if (current >= limit) {
        return responses.error(res, 429, 'Quota exceeded', 'You have reached the usage limit for this resource')({
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
