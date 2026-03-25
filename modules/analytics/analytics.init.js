/**
 * Module dependencies
 */
import AnalyticsService from './services/analytics.service.js';
import analyticsMiddleware from './middlewares/analytics.middleware.js';
import billingEvents from '../billing/lib/events.js';

/**
 * Initialise the analytics module.
 * Called automatically by the Express init loop (matched via the
 * `modules/{name}/{name}.init.js` glob in config/assets.js).
 *
 * Registers the auto-capture middleware so every API request is tracked.
 * The middleware reads identity context (`req.user`, `req.organization`)
 * lazily inside the `res.on('finish')` handler, so it is safe to mount
 * here — before route-level auth middleware is wired.
 *
 * Listens for billing plan changes to update group properties.
 *
 * @param {object} app - Express application instance
 * @returns {Promise<void>}
 */
export default async (app) => {
  await AnalyticsService.init();
  app.use(analyticsMiddleware);

  // Listen for billing plan changes and update group properties
  billingEvents.on('plan.changed', ({ organizationId, newPlan }) => {
    try {
      AnalyticsService.groupIdentify('company', String(organizationId), { plan: newPlan });
    } catch (_) { /* analytics must not break billing flow */ }
  });
};
