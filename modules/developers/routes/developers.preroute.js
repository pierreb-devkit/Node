/**
 * Module dependencies
 */
import authenticateApiKey from '../middlewares/developers.authenticateApiKey.js';

/**
 * @desc Register developers pre-parser routes (mounted before body parsing)
 * The API key auth middleware runs early so subsequent routes can use req.organization/req.apiKeyAuth.
 * @param {Object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  app.use('/api', authenticateApiKey);
};
