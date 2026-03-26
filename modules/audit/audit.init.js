/**
 * Module dependencies
 */
import config from '../../config/index.js';

/**
 * Initialise the audit module.
 * Called automatically by the Express init loop (matched via the
 * `modules/{name}/{name}.init.js` glob in config/assets.js).
 *
 * The audit module is a lightweight service — no middleware to mount.
 * This init simply logs activation status at startup.
 *
 * @param {object} _app - Express application instance (unused)
 * @returns {Promise<void>}
 */
export default async (/* app */) => {
  if (process.env.NODE_ENV !== 'test') {
    const enabled = config.audit?.enabled ?? false;
    console.log(`Audit module: ${enabled ? 'enabled' : 'disabled'}`);
  }
};
