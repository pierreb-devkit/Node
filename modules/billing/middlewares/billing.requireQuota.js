/**
 * Module dependencies
 */
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';
import BillingUsageService from '../services/billing.usage.service.js';
import BillingExtraBalanceRepository from '../repositories/billing.extraBalance.repository.js';
import BillingPlanService from '../services/billing.plan.service.js';

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
 *   First checks for past_due degraded mode:
 *     - past_due + pastDueSince set + within 7-day grace: sets res.locals.billingDegraded = true
 *       and falls through to the meter check (may still block on exhaustion).
 *     - past_due + pastDueSince set + grace elapsed (>=7d): returns 402 PAYMENT_PAST_DUE.
 *   Then computes `(meterQuota - meterUsed) + extrasBalance`. Returns 402 METER_EXHAUSTED when <= 0.
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

    // Bypass for admin users or meter-exempt organizations
    if (req.user?.roles?.includes('admin')) return next();
    if (req.organization.meterExempt === true) return next();

    try {
      // ── Meter mode (meterMode: true) ──────────────────────────────────────
      if (config.billing?.meterMode === true) {
        const orgId = req.organization._id.toString();

        // ── Degraded-mode gate (past_due grace period) ─────────────────────
        const subscription = await SubscriptionRepository.findByOrganization(req.organization._id);
        if (subscription?.status === 'past_due' && subscription.pastDueSince != null) {
          const gracePeriodMs = 7 * 24 * 60 * 60 * 1000;
          const elapsed = Date.now() - new Date(subscription.pastDueSince).getTime();
          if (elapsed >= gracePeriodMs) {
            return responses.error(res, 402, 'Payment Required', 'Subscription past due, please update payment')({
              type: 'PAYMENT_PAST_DUE',
              message: 'Subscription past due, please update payment',
              subscriptionStatus: 'past_due',
            });
          }
          // Within grace period — mark degraded for downstream awareness but allow through
          res.locals.billingDegraded = true;
        }

        const usage = await BillingUsageService.getMeter(orgId);
        const extrasBalance = await BillingExtraBalanceRepository.getBalance(orgId);

        let meterUsed;
        let meterQuota;

        if (!usage) {
          // No BillingUsage doc yet (new user / first scrap of the week).
          // Don't create the doc here — let incrementMeter do it on first attribution.
          // Fall back to the plan quota so first-run requests are not blocked.
          // Reuse the `subscription` already fetched by the degraded-mode gate above.
          const planId = subscription?.plan ?? config?.billing?.defaultPlan ?? 'free';
          const activePlan = await BillingPlanService.getActivePlan(planId);
          meterUsed = 0;
          meterQuota = activePlan?.meterQuota ?? 0;
        } else {
          meterUsed = usage.meterUsed ?? 0;
          meterQuota = usage.meterQuota ?? 0;
        }

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
