/**
 * Module dependencies
 */
import config from '../../config/index.js';
import analyticsService from './analytics.js';

/**
 * Capture an exception in PostHog.
 *
 * Active when `config.posthog.apiKey` is set AND
 * `config.posthog.errorTracking === true`.
 *
 * Safe no-op when PostHog is not configured.
 *
 * @param {Error} err - Error to capture
 * @param {Object} [ctx] - Optional context attached to the event
 * @param {string} [ctx.distinctId] - User identifier for PostHog
 * @param {string} [ctx.requestId] - Request trace ID
 * @returns {void}
 */
const captureException = (err, ctx = {}) => {
  const posthogConfig = config?.posthog ?? {};
  if (posthogConfig.apiKey && posthogConfig.errorTracking === true) {
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
 * Mounts a 4-arg error middleware that captures the exception
 * to PostHog and passes it down to the next handler.
 *
 * @param {import('express').Express} app - Express application instance
 */
const setupExpressErrorHandler = (app) => {
  // `_res` is required for Express to recognise this as a 4-arg error handler
  app.use((err, req, _res, next) => {
    const distinctId = req.user?._id
      ? String(req.user._id)
      : req.user?.id
        ? String(req.user.id)
        : 'anonymous';
    captureException(err, { distinctId, requestId: req.id });
    next(err);
  });
};

export default {
  init,
  captureException,
  setupExpressErrorHandler,
};
