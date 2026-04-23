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
 * Capture an exception in PostHog only (skips Sentry).
 * Used inside the Express error middleware where Sentry's own Express handler
 * has already reported the error — calling captureException() here would
 * report it to Sentry a second time.
 *
 * @param {Error} err - Error to capture
 * @param {Object} [ctx] - Optional context
 * @returns {void}
 */
const captureExceptionPostHogOnly = (err, ctx = {}) => {
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
 * context), then a PostHog-only fan-out middleware to avoid double-reporting
 * to Sentry (which is already covered by Sentry's own Express handler).
 *
 * @param {import('express').Express} app - Express application instance
 */
const setupExpressErrorHandler = (app) => {
  // Sentry Express handler (structured request/response context)
  sentryService.setupExpressErrorHandler(app);

  // PostHog-only fan-out middleware — Sentry already handled above
  // `_res` is required for Express to recognise this as a 4-arg error handler
  app.use((err, req, _res, next) => {
    const distinctId = req.user?._id
      ? String(req.user._id)
      : req.user?.id
        ? String(req.user.id)
        : 'anonymous';
    captureExceptionPostHogOnly(err, { distinctId, requestId: req.id });
    next(err);
  });
};

export default {
  init,
  captureException,
  captureExceptionPostHogOnly,
  setupExpressErrorHandler,
};
