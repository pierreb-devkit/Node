/**
 * Billing quota assertion service.
 *
 * Single source of truth for quota/meter enforcement logic extracted from
 * `billing.requireQuota.js`. Exposes `assertCanExecute` so both the HTTP
 * middleware and any other caller (e.g. background workers, tool handlers)
 * share the exact same enforcement path — no divergence, no bypass.
 *
 * Dual mode (mirrors `billing.requireQuota.js` exactly):
 * - `meterMode === false` (default): legacy quota — reads counters from
 *   `config.billing.quotas[plan][resource][action]` via BillingUsageService.
 * - `meterMode === true`: meter gate — past_due grace period + meterQuota
 *   + extrasBalance. Fail-closed for paused/unpaid/incomplete/canceled.
 *
 * On denial throws an `AppError` with a `status` property matching the HTTP
 * status that `billing.requireQuota.js` would have returned (402 / 429 / 503).
 * Callers can inspect `err.status` to produce the right protocol-level response.
 *
 * @module billing.quota.service
 */
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';
import BillingUsageService from './billing.usage.service.js';
import BillingExtraBalanceRepository from '../repositories/billing.extraBalance.repository.js';
import BillingPlanService from './billing.plan.service.js';

import { activeStatuses } from '../lib/constants.js';
import { getDefaultPlanId, getGracePeriodDays } from '../lib/billing.constants.js';
import config from '../../../config/index.js';
import AppError from '../../../lib/helpers/AppError.js';

/**
 * @typedef {Object} QuotaDenyReason
 * @property {string} type - Machine-readable denial type (METER_EXHAUSTED, PAYMENT_PAST_DUE, QUOTA_EXCEEDED, PLAN_NOT_CONFIGURED)
 * @property {number} status - HTTP-equivalent status code (402, 429, 503)
 * @property {Object} [details] - Additional metadata (meterUsed, meterQuota, etc.)
 */

/**
 * @desc Assert that an organization may execute a metered action.
 *
 * Mirrors the exact enforcement tree in `billing.requireQuota.js`:
 *   1. Admin bypass (user.roles includes 'admin') → allow
 *   2. meterExempt org → allow
 *   3. meterMode === true  → meter gate (fail-closed + past_due grace + exhaustion)
 *   4. meterMode === false → legacy quota gate (plan counter)
 *
 * @param {Object} opts
 * @param {string|Object} opts.orgId - Organization _id (string or ObjectId)
 * @param {Object} [opts.organization] - Organization document (for meterExempt check)
 * @param {Object} [opts.user] - Authenticated user (for admin bypass)
 * @param {string} opts.resource - Quota resource name (e.g. 'scraps')
 * @param {string} opts.action  - Quota action name (e.g. 'execute')
 * @returns {Promise<{degraded: boolean}>} Resolves with `{ degraded }` when access is allowed.
 *   `degraded` is true when past_due within grace period (informational).
 * @throws {AppError} with `.status` set to 402 / 429 / 503 on denial.
 */
async function assertCanExecute({ orgId, organization, user, resource, action }) {
  // ── Admin bypass ──────────────────────────────────────────────────────────
  if (user?.roles?.includes('admin')) return { degraded: false };

  // ── meterExempt bypass ────────────────────────────────────────────────────
  if (organization?.meterExempt === true) return { degraded: false };

  const orgIdStr = String(orgId);

  // ── Meter mode ────────────────────────────────────────────────────────────
  if (config.billing?.meterMode === true) {
    const subscription = await SubscriptionRepository.findByOrganization(orgIdStr);

    // Fail-closed statuses → route to free plan quota
    const failClosedStatuses = ['paused', 'unpaid', 'incomplete_expired', 'incomplete', 'canceled'];
    if (subscription && failClosedStatuses.includes(subscription.status)) {
      const planId = getDefaultPlanId();
      const freePlan = BillingPlanService.getActivePlan(planId);
      if (!freePlan) {
        throw new AppError('Billing plan configuration is temporarily unavailable', {
          status: 503,
          details: { type: 'PLAN_NOT_CONFIGURED', planId },
        });
      }
      const extrasBalance = await BillingExtraBalanceRepository.getBalance(orgIdStr);
      const remaining = (freePlan.meterQuota ?? 0) + extrasBalance;
      if (remaining <= 0) {
        throw new AppError('Meter exhausted', {
          status: 402,
          details: {
            type: 'METER_EXHAUSTED',
            meterUsed: 0,
            meterQuota: freePlan.meterQuota ?? 0,
            extrasRemaining: extrasBalance,
            packsAvailable: config.billing?.packs ?? [],
            upgradeUrl: config.billing?.upgradeUrl ?? '/billing/plans',
          },
        });
      }
      return { degraded: false };
    }

    // past_due grace period gate
    let degraded = false;
    if (subscription?.status === 'past_due' && subscription.pastDueSince != null) {
      const gracePeriodMs = getGracePeriodDays() * 24 * 60 * 60 * 1000;
      const elapsed = Date.now() - new Date(subscription.pastDueSince).getTime();
      if (elapsed >= gracePeriodMs) {
        throw new AppError('Subscription past due, please update payment', {
          status: 402,
          details: {
            type: 'PAYMENT_PAST_DUE',
            message: 'Subscription past due, please update payment',
            subscriptionStatus: 'past_due',
          },
        });
      }
      // Within grace period — mark degraded for informational purposes
      degraded = true;
    }

    const usage = await BillingUsageService.getMeter(orgIdStr);
    const extrasBalance = await BillingExtraBalanceRepository.getBalance(orgIdStr);

    let meterUsed;
    let meterQuota;

    if (!usage) {
      // No BillingUsage doc yet — fall back to plan quota
      const planId = subscription?.plan ?? getDefaultPlanId();
      const activePlan = BillingPlanService.getActivePlan(planId);
      if (!activePlan) {
        throw new AppError('Billing plan configuration is temporarily unavailable', {
          status: 503,
          details: { type: 'PLAN_NOT_CONFIGURED', planId },
        });
      }
      meterUsed = 0;
      meterQuota = activePlan.meterQuota ?? 0;
    } else {
      meterUsed = usage.meterUsed ?? 0;
      meterQuota = usage.meterQuota ?? 0;
    }

    // Clamp plan headroom to 0: meterUsed is $inc'd uncapped past meterQuota, and the
    // overflow units are also debited from extrasBalance. Without the clamp the same
    // overflow is subtracted twice, denying paying orgs that still hold extras.
    const remaining = Math.max(0, meterQuota - meterUsed) + extrasBalance;
    if (remaining <= 0) {
      throw new AppError('Meter exhausted', {
        status: 402,
        details: {
          type: 'METER_EXHAUSTED',
          meterUsed,
          meterQuota,
          extrasRemaining: extrasBalance,
          packsAvailable: config.billing?.packs ?? [],
          upgradeUrl: config.billing?.upgradeUrl ?? '/billing/plans',
        },
      });
    }

    return { degraded };
  }

  // ── Legacy mode ───────────────────────────────────────────────────────────
  const subscription = await SubscriptionRepository.findByOrganization(orgIdStr);
  const plan = (!subscription || !activeStatuses.includes(subscription.status))
    ? 'free'
    : (subscription.plan || 'free');

  const quotas = config.billing?.quotas;
  const limit = quotas?.[plan]?.[resource]?.[action];

  // No quota configured for this plan/resource/action → allow
  if (limit === undefined || limit === null) return { degraded: false };

  // Infinity means unlimited
  if (limit === Infinity) return { degraded: false };

  const usage = await BillingUsageService.get(orgIdStr);
  const counterKey = `${resource}_${action}`;
  const current = usage.counters[counterKey] || 0;

  if (current >= limit) {
    throw new AppError('You have reached the usage limit for this resource', {
      status: 429,
      details: {
        type: 'QUOTA_EXCEEDED',
        resource,
        action,
        limit,
        current,
        upgradeUrl: config.billing?.upgradeUrl || '/billing/plans',
      },
    });
  }

  return { degraded: false };
}

export { assertCanExecute };
export default { assertCanExecute };
