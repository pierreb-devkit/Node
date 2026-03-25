/**
 * Module dependencies
 */
import AnalyticsService from './services/analytics.service.js';

/**
 * Initialise the analytics module.
 * Called automatically by the Express init loop (matched via the
 * `modules/{name}/{name}.init.js` glob in config/assets.js).
 * @param {object} _app - Express application instance (unused)
 * @returns {Promise<void>}
 */
// eslint-disable-next-line no-unused-vars
export default async (_app) => {
  await AnalyticsService.init();
};
