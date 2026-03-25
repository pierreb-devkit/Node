/**
 * Module dependencies
 */
import FeatureFlagsService from '../services/analytics.featureFlags.service.js';

import responses from '../../../lib/helpers/responses.js';

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

        return responses.error(res, 403, 'Forbidden', 'Feature not available on your current plan')({
          type: 'FEATURE_FLAG_DISABLED',
          flag: flagName,
        });
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export default requireFeatureFlag;
