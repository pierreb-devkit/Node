/**
 * Module dependencies
 */
import config from '../../config/index.js';
import AnalyticsService from '../../lib/services/analytics.js';
import billingEvents from './lib/events.js';

/**
 * Billing module initialisation.
 * Wires cross-module integrations that depend on services from lib.
 *
 * @param {import('express').Application} app - Express application instance
 * @returns {Promise<void>}
 */
// eslint-disable-next-line no-unused-vars
export default async (app) => {
  // Warn at startup if any pack is missing a valid priceUsd — refundPartial fallback will be inaccurate
  if (config.billing?.packs?.length) {
    for (const pack of config.billing.packs) {
      if (typeof pack.priceUsd !== 'number' || pack.priceUsd <= 0) {
        console.warn(`[billing] pack '${pack.packId}' missing valid priceUsd; refundPartial fallback will be inaccurate`);
      }
    }
  }

  // Update analytics group properties when a subscription plan changes
  billingEvents.on('plan.changed', ({ organizationId, newPlan }) => {
    try {
      AnalyticsService.groupIdentify('company', String(organizationId), { plan: newPlan });
    } catch (_) { /* analytics must not break billing flow */ }
  });
};
