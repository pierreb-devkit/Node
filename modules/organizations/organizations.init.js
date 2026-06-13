/**
 * Module dependencies
 */
import logger from '../../lib/services/logger.js';
import organizationEvents from './lib/events.js';

/**
 * Organizations module initialisation.
 *
 * Nothing to boot today beyond event hygiene: the `organization.provisioned`
 * singleton (lib/events.js) stays config-free / import-safe, so the mandatory
 * 'error' listener is registered HERE, after config is ready (an unhandled
 * 'error' emit would crash the process — Node default behaviour; mirrors
 * invitations.init.js / billing.init.js).
 *
 * @returns {Promise<void>}
 */
export default async () => {
  organizationEvents.on('error', (err) => logger.error('[organizationEvents] uncaught error', { err }));
};
