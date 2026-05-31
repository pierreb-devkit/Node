/**
 * Module dependencies
 */
import BillingQuotaService from '../services/billing.quota.service.js';
import responses from '../../../lib/helpers/responses.js';

/**
 * Returns Express middleware that gates access based on plan quotas.
 *
 * Dual mode — both enforced via `BillingQuotaService.assertCanExecute`:
 * - When `config.billing.meterMode === false` (default): legacy quota logic.
 *   Reads limits from `config.billing.quotas[plan][resource][action]` and
 *   compares against the current month's usage via BillingUsageService.
 *   When no quota is configured or limit is Infinity, the request is allowed.
 *
 * - When `config.billing.meterMode === true`: meter quota gate.
 *   First checks for past_due degraded mode (grace period = config.billing.gracePeriodDays, default 7):
 *     - past_due + pastDueSince set + within grace period: sets res.locals.billingDegraded = true
 *       and falls through to the meter check (may still block on exhaustion).
 *     - past_due + pastDueSince set + grace elapsed: returns 402 PAYMENT_PAST_DUE.
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

    try {
      const orgId = req.organization._id.toString();
      const { degraded } = await BillingQuotaService.assertCanExecute({
        orgId,
        organization: req.organization,
        user: req.user,
        resource,
        action,
      });

      if (degraded) {
        res.locals.billingDegraded = true;
      }

      return next();
    } catch (err) {
      // Map AppError status codes to HTTP responses matching previous behavior.
      // Extract denial details from the AppError (may be array or object).
      const details = Array.isArray(err.details) ? err.details[0] : err.details;

      if (err.status === 402) {
        if (details?.type === 'PAYMENT_PAST_DUE') {
          return responses.error(res, 402, 'Payment Required', 'Subscription past due, please update payment')(details);
        }
        if (details?.type === 'METER_EXHAUSTED') {
          return responses.error(res, 402, 'Payment Required', 'Meter exhausted')(details);
        }
        return responses.error(res, 402, 'Payment Required', err.message)(details);
      }
      if (err.status === 429) {
        return responses.error(res, 429, 'Quota exceeded', 'You have reached the usage limit for this resource')(details);
      }
      if (err.status === 503) {
        return responses.error(res, 503, 'Service Unavailable', 'Billing plan configuration is temporarily unavailable')(details);
      }
      return next(err);
    }
  };
}

export default requireQuota;
