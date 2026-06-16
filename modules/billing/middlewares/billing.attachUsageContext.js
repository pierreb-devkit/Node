/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import BillingUsageService from '../services/billing.usage.service.js';
import BillingExtraBalanceRepository from '../repositories/billing.extraBalance.repository.js';

/**
 * @desc Express middleware that decorates `req.meterContext` with the current
 *       meter usage, quota, extras remaining, and breakdown for downstream handlers.
 *       Also sets the `X-Meter-Remaining` response header to enable Vue mini-bar polling.
 *
 *       Only active when `config.billing.meterMode === true`.
 *       In legacy mode (meterMode=false), this middleware is a no-op pass-through.
 *
 *       Failures are non-blocking: any error is logged and the request continues.
 *       Mount after `resolveOrganization` so that `req.organization` is populated.
 *
 *       NOTE: This middleware is documented here but intentionally NOT auto-wired in
 *       lib/app.js — downstream projects decide where to mount it.
 *       Example: `app.use(resolveOrganization, attachUsageContext);`
 *
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js middleware, not Qwik
const attachUsageContext = async (req, res, next) => {
  // No-op when meterMode is disabled or organization is not resolved
  if (!config.billing?.meterMode || !req.organization) {
    return next();
  }

  try {
    const orgId = req.organization._id.toString();

    const [meter, extrasBalance] = await Promise.all([
      BillingUsageService.getMeter(orgId),
      BillingExtraBalanceRepository.getBalance(orgId),
    ]);

    const meterUsed = meter?.meterUsed ?? 0;
    const meterQuota = meter?.meterQuota ?? 0;
    const remaining = (meterQuota - meterUsed) + extrasBalance;

    req.meterContext = {
      used: meterUsed,
      quota: meterQuota,
      extrasRemaining: extrasBalance,
      breakdown: meter?.meterBreakdown ?? {},
    };

    res.setHeader('X-Meter-Remaining', String(remaining));
  } catch (err) {
    // Non-blocking — log and continue. Never let a context decorator 500 the request.
    try {
      const { default: logger } = await import('../../../lib/services/logger.js');
      logger.error('[billing.attachUsageContext] Failed to attach meter context:', err);
    } catch {
      // logger import failed — silently ignore
    }
  }

  return next();
};

export default attachUsageContext;
