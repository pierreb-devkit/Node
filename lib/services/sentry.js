/**
 * Module dependencies
 */
import config from '../../config/index.js';
import logger from './logger.js';

/**
 * Sentry client reference (null when not configured).
 * @type {import('@sentry/node')|null}
 */
let Sentry = null;

/**
 * Initialise Sentry error tracking.
 * When `sentry.dsn` is absent or `sentry.enabled` is false the service stays
 * in no-op mode — every public method silently returns without side-effects.
 *
 * The `@sentry/node` SDK is lazy-loaded (dynamic import) so that
 * applications that don't use Sentry are never affected.
 * @returns {Promise<void>}
 */
const init = async () => {
  const { dsn, environment, enabled } = config.sentry ?? {};
  if (!dsn || enabled === false) return;

  try {
    const sentryModule = await import('@sentry/node');
    Sentry = sentryModule.default || sentryModule;
    Sentry.init({
      dsn,
      environment: environment || process.env.NODE_ENV || 'development',
      // Adjust sample rates for production
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    });
  } catch (err) {
    logger.error('Sentry init failed:', err);
    Sentry = null;
  }
};

/**
 * Set up the Sentry Express error handler.
 * Must be called after all routes are mounted.
 * @param {Object} app - Express application instance
 */
const setupExpressErrorHandler = (app) => {
  if (!Sentry) return;
  Sentry.setupExpressErrorHandler(app);
};

/**
 * Capture an exception in Sentry.
 * Safe to call even when Sentry is not configured.
 * @param {Error} err - Error to capture
 */
const captureException = (err) => {
  if (!Sentry) return;
  Sentry.captureException(err);
};

/**
 * Flush pending events and close the Sentry client.
 * @param {number} [timeout=2000] - Timeout in ms
 * @returns {Promise<void>}
 */
const shutdown = async (timeout = 2000) => {
  if (!Sentry) return;
  await Sentry.close(timeout);
  Sentry = null;
};

export default {
  init,
  setupExpressErrorHandler,
  captureException,
  shutdown,
};
