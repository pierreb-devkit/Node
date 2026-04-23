/**
 * Module dependencies
 */
import config from '../../config/index.js';
import sentryService from './sentry.js';
import analyticsService from './analytics.js';

/**
 * Capture an exception, fanning out to all active trackers.
 *
 * - Sentry  : active when `config.sentry.dsn` is set (and `enabled !== false`)
 * - PostHog : active when `config.posthog.apiKey` is set AND
 *             `config.posthog.errorTracking === true`
 *
 * Safe no-op when neither tracker is configured.
 *
 * @param {Error} err - Error to capture
 * @param {Object} [ctx] - Optional context attached to the event
 * @param {string} [ctx.distinctId] - User identifier for PostHog
 * @param {string} [ctx.requestId] - Request trace ID
 * @returns {void}
 */
const captureException = (err, ctx = {}) => {
  // Sentry fan-out
  const sentryConfig = config?.sentry ?? {};
  if (sentryConfig.dsn && sentryConfig.enabled !== false) {
    sentryService.captureException(err);
  }

  // PostHog fan-out — only when errorTracking is explicitly opted-in
  const posthogConfig = config?.posthog ?? {};
  if (posthogConfig.apiKey && posthogConfig.errorTracking === true) {
    analyticsService.captureException(err, ctx);
  }
};

/**
 * Initialise all configured trackers (Sentry + PostHog).
 * Safe to call when neither is configured.
 * @returns {Promise<void>}
 */
const init = async () => {
  await Promise.all([
    sentryService.init(),
    analyticsService.init(),
  ]);
};

/**
 * Set up Express error handling for all active trackers.
 *
 * Must be called after all routes are mounted.
 * Mounts Sentry's Express error handler first (captures structured request
 * context), then a generic 4-arg middleware that fans out via captureException.
 *
 * @param {import('express').Express} app - Express application instance
 */
const setupExpressErrorHandler = (app) => {
  // Sentry Express handler (structured request/response context)
  sentryService.setupExpressErrorHandler(app);

  // Fan-out error middleware — runs after Sentry's handler
  app.use((err, req, res, next) => {
    captureException(err, {
      distinctId: req.userId || (req.user?._id ? String(req.user._id) : 'anonymous'),
      requestId: req.id,
    });
    next(err);
  });
};

export default {
  init,
  captureException,
  setupExpressErrorHandler,
};
