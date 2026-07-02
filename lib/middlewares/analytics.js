/**
 * Module dependencies
 */
import AnalyticsService from '../services/analytics.js';
import logger from '../services/logger.js';
import { redactPathSecrets } from '../helpers/redactUrl.js';

/**
 * Default route prefixes to skip when auto-capturing API request events.
 * Health checks and static assets generate high-frequency, low-value noise.
 * @type {string[]}
 */
const SKIP_PREFIXES = ['/api/health', '/public', '/favicon'];

/**
 * Create an Express middleware that auto-captures `api_request` events via the
 * analytics service. Attaches a `res.on('finish')` listener so that the
 * status code and response time are available when the event is recorded.
 *
 * Identity context (`req.user`, `req.organization`) is read lazily inside the
 * `finish` handler — not at middleware execution time — so the middleware can
 * safely be mounted before auth/org resolution.
 *
 * The middleware is a no-op when PostHog is not configured because
 * `AnalyticsService.track()` itself short-circuits without a client.
 *
 * @param {Object} [options] - Configuration options
 * @param {string[]} [options.skipPrefixes] - Route prefixes to skip (defaults to SKIP_PREFIXES)
 * @returns {import('express').RequestHandler}
 */
const createAnalyticsMiddleware = (options = {}) => {
  const prefixes = options.skipPrefixes || SKIP_PREFIXES;

  return (req, res, next) => {
    const rawUrl = req.originalUrl || req.url;
    const endpoint = (rawUrl || '').split('?')[0] || '/';

    // Skip routes that produce high-frequency, low-value events
    if (prefixes.some((prefix) => endpoint.startsWith(prefix))) {
      return next();
    }

    const start = Date.now();

    res.on('finish', () => {
      try {
        const distinctId = req.user?._id ? String(req.user._id) : 'anonymous';
        const groups = req.organization?._id ? { company: String(req.organization._id) } : undefined;

        // Never let a single-use secret carried as a PATH parameter (e.g.
        // /api/auth/reset/:token) reach the analytics store. Prefer the matched
        // route pattern (resolved by the time `finish` fires) so path params
        // collapse to their placeholder; fall back to redacting known secret
        // segments from the concrete path (unmatched routes / 404s).
        const routePath = typeof req.route?.path === 'string' ? req.route.path : null;
        const safeEndpoint = routePath ? `${req.baseUrl || ''}${routePath}` : redactPathSecrets(endpoint);

        AnalyticsService.track(distinctId, 'api_request', {
          endpoint: safeEndpoint,
          method: req.method,
          statusCode: res.statusCode,
          responseTime: Date.now() - start,
        }, groups);
      } catch (err) {
        logger.debug('[analytics] finish handler error: %s', err.message);
      }
    });

    return next();
  };
};

/**
 * Pre-built middleware instance using default options.
 * @type {import('express').RequestHandler}
 */
const analyticsMiddleware = createAnalyticsMiddleware();

export { createAnalyticsMiddleware, SKIP_PREFIXES };
export default analyticsMiddleware;
