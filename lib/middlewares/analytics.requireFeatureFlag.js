/**
 * Module dependencies
 */
import FeatureFlagsService from '../services/analytics.featureFlags.js';

import AppError from '../helpers/AppError.js';
import responses from '../helpers/responses.js';

/**
 * Returns Express middleware that gates access based on a PostHog feature flag.
 *
 * The middleware evaluates the flag for the authenticated user, passing
 * organisation context when available.  Behaviour by scenario:
 *
 * - Flag enabled  -> next()
 * - Flag disabled -> 403
 * - Analytics not configured (no PostHog key) -> next() (fail-open so
 *   projects not using PostHog are never blocked)
 *
 * @param {string} flagName - PostHog feature flag key
 * @returns {Function} Express middleware function
 */
function requireFeatureFlag(flagName) {
  /**
   * Evaluate the flag for the caller and block the request when it is off.
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next callback.
   * @returns {Promise<object|void>} Resolves when middleware handling
   *   completes: the `responses.error` envelope object on the 401 and 403
   *   branches, otherwise whatever `next()` returns. Note the sibling
   *   `requireQuotaMiddleware` in `modules/billing/middlewares/billing.requireQuota.js`
   *   documents the same shape as `Promise<void>`, which is inaccurate for
   *   its error branches too — not corrected here, out of this issue's scope.
   */
  return async function requireFeatureFlagMiddleware(req, res, next) {
    const distinctId = req.user?._id ? String(req.user._id) : undefined;
    if (!distinctId) {
      return responses.error(res, 401, 'Unauthorized', 'Authentication required to evaluate feature flag')();
    }

    try {
      const options = {};
      if (req.organization?._id) {
        options.groups = { company: String(req.organization._id) };
      }

      const enabled = await FeatureFlagsService.isEnabled(flagName, distinctId, options);

      // isEnabled returns false both when the flag is off AND when analytics
      // is not configured.  Distinguish by checking getVariant: undefined
      // means not configured (fail-open), while false/string means configured.
      if (!enabled) {
        const variant = await FeatureFlagsService.getVariant(flagName, distinctId, options);
        // undefined -> analytics not configured -> fail-open
        if (variant === undefined) return next();

        // responses.error(...)(x) reads `x.details`, not `x` itself (issue
        // #4064 — same call-convention bug fixed for billing.requireQuota.js
        // in #4062). Pass an AppError whose `.details` carries this data,
        // not a flat object, or the whitelist below never sees it.
        //
        // `type` is on the built-in whitelist (lib/helpers/responses.js
        // DEFAULT_DETAILS_WHITELIST) and safe: it only tells a client "you
        // were gated by a feature flag", the same class of signal as an
        // HTTP status code. `flag` is deliberately left OFF the whitelist —
        // it names an internal PostHog feature-toggle key, and publishing
        // it would let any authenticated caller enumerate which flags gate
        // which routes. It stays in `details` for dev-only debugging
        // (the serialized-error blob), never in the production body.
        return responses.error(res, 403, 'Forbidden', 'Feature not available on your current plan')(
          new AppError('Feature not available on your current plan', {
            status: 403,
            details: { type: 'FEATURE_FLAG_DISABLED', flag: flagName },
          }),
        );
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export default requireFeatureFlag;
