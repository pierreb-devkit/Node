/**
 * Module dependencies
 */
import config from '../../config/index.js';
import auditMiddleware from './middlewares/audit.middleware.js';

/**
 * Initialise the audit module.
 * Called automatically by the Express init loop (matched via the
 * `modules/{name}/{name}.init.js` glob in config/assets.js).
 *
 * Registers the auto-capture middleware so every mutating API request
 * is audit-logged. The middleware reads identity context (`req.user`,
 * `req.organization`) lazily inside the `res.on('finish')` handler,
 * so it is safe to mount here — before route-level auth middleware.
 *
 * @param {object} app - Express application instance
 * @returns {Promise<void>}
 */
export default async (app) => {
  app.use(auditMiddleware);

  if (process.env.NODE_ENV !== 'test') {
    const enabled = config.audit?.enabled ?? false;
    console.log(`Audit module: ${enabled ? 'enabled' : 'disabled'}`);
  }
};
