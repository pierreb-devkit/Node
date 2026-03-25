/**
 * Module dependencies
 */
import AnalyticsService from './services/analytics.service.js';
import analyticsMiddleware from './middlewares/analytics.middleware.js';

/**
 * Initialise the analytics module.
 * Called automatically by the Express init loop (matched via the
 * `modules/{name}/{name}.init.js` glob in config/assets.js).
 * Registers the auto-capture middleware so every API request is tracked.
 * @param {object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  AnalyticsService.init();
  app.use(analyticsMiddleware);
};
