/**
 * Module dependencies
 */
import config from '../../config/index.js';
import analyticsService from './analytics.js';
import { redactRequestPath } from '../helpers/redactUrl.js';

/**
 * Capture an exception in PostHog.
 *
 * Active when `config.analytics.posthog.key` is set AND
 * `config.analytics.posthog.errorTracking === true`.
 *
 * Safe no-op when PostHog is not configured.
 *
 * @param {Error} err - Error to capture
 * @param {Object} [ctx] - Optional context attached to the event
 * @param {string} [ctx.distinctId] - User identifier for PostHog
 * @param {string} [ctx.requestId] - Request trace ID
 * @param {Object} [ctx.properties] - Additional properties merged into the event
 * @returns {void}
 */
const captureException = (err, ctx = {}) => {
  const posthogConfig = config?.analytics?.posthog ?? {};
  if (posthogConfig.key && posthogConfig.errorTracking === true) {
    analyticsService.captureException(err, ctx);
  }
};

/**
 * Initialise PostHog analytics (error tracking backend).
 * Safe to call when PostHog is not configured.
 * @returns {Promise<void>}
 */
const init = async () => {
  await analyticsService.init();
};

/**
 * Set up Express error handling for PostHog Error Tracking.
 *
 * Must be called after all routes are mounted.
 * Mounts a 4-arg error middleware that captures server errors (status >= 500)
 * to PostHog with the request context (`method`, redacted `endpoint`,
 * `statusCode`) and passes the error down to the next handler. Expected 4xx
 * outcomes are not captured. An error with no message (or a non-Error value)
 * is captured as an `Error` named `<METHOD> <endpoint> <status>` so its group
 * is readable; the original error is never mutated beyond the dedup flag.
 *
 * Every error object (4xx included) is flagged `posthogCaptured` so the Winston
 * PostHog transport does not capture it again when it is logged downstream.
 * A thrown primitive (e.g. a string) cannot carry the flag, so the transport
 * may capture it a second time.
 *
 * @param {import('express').Express} app - Express application instance
 */
const setupExpressErrorHandler = (app) => {
  // `_res` is required for Express to recognise this as a 4-arg error handler
  app.use((err, req, _res, next) => {
    // Same status rule as initErrorRoutes (lib/services/express.js) —
    // res.statusCode is not set yet at this point.
    const status = err?.status || 500;
    if (status >= 500) {
      const distinctId = req.user?._id
        ? String(req.user._id)
        : req.user?.id
          ? String(req.user.id)
          : 'anonymous';
      const endpoint = redactRequestPath(req);
      const target = err?.message
        ? err
        : Object.assign(
          new Error(`${req.method} ${endpoint} ${status}`),
          err?.name ? { name: err.name } : {},
          err?.stack ? { stack: err.stack } : {},
        );
      captureException(target, {
        distinctId,
        requestId: req.id,
        properties: { method: req.method, endpoint, statusCode: status },
      });
    }
    if (err && typeof err === 'object') err.posthogCaptured = true;
    next(err);
  });
};

export default {
  init,
  captureException,
  setupExpressErrorHandler,
};
