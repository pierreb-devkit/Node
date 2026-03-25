/**
 * Module dependencies
 */
import AnalyticsService from './services/analytics.service.js';
import billingEvents from '../billing/lib/events.js';

/**
 * Initialise the analytics module.
 * Called automatically by the Express init loop (matched via the
 * `modules/{name}/{name}.init.js` glob in config/assets.js).
 * Listens for billing plan changes to update group properties.
 * @param {object} _app - Express application instance (unused)
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars
export default (_app) => {
  AnalyticsService.init();

  // Listen for billing plan changes and update group properties
  billingEvents.on('plan.changed', ({ organizationId, newPlan }) => {
    try {
      AnalyticsService.groupIdentify('company', String(organizationId), { plan: newPlan });
    } catch (_) { /* analytics must not break billing flow */ }
  });
};
