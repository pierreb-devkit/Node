/**
 * Module dependencies
 */
import AnalyticsService from '../services/analytics.service.js';

/**
 * Route prefixes to skip when auto-capturing API request events.
 * Health checks and static assets generate high-frequency, low-value noise.
 * @type {string[]}
 */
const SKIP_PREFIXES = ['/api/health', '/public', '/favicon'];

/**
 * Express middleware that auto-captures `api_request` events via the
 * analytics service. Attaches a `res.on('finish')` listener so that the
 * status code and response time are available when the event is recorded.
 *
 * The middleware is a no-op when PostHog is not configured because
 * `AnalyticsService.track()` itself short-circuits without a client.
 *
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next callback
 * @returns {void}
 */
const analyticsMiddleware = (req, res, next) => {
  const url = req.originalUrl || req.url;

  // Skip routes that produce high-frequency, low-value events
  if (SKIP_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return next();
  }

  const start = Date.now();

  res.on('finish', () => {
    const distinctId = req.user?._id ? String(req.user._id) : 'anonymous';
    const groups = req.organization?._id ? { company: String(req.organization._id) } : undefined;

    AnalyticsService.track(distinctId, 'api_request', {
      endpoint: url,
      method: req.method,
      statusCode: res.statusCode,
      responseTime: Date.now() - start,
    }, groups);
  });

  return next();
};

export default analyticsMiddleware;
