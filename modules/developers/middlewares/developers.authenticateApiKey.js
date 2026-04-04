/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import responses from '../../../lib/helpers/responses.js';
import ApiKeyService from '../services/developers.apiKey.service.js';

const KEY_PREFIX = 'trawl_';

/**
 * @desc Middleware to authenticate requests via API key.
 * Checks `X-API-Key: trawl_...` header.
 * If valid, sets req.organization and req.apiKeyAuth.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 * @returns {void}
 */
const authenticateApiKey = async (req, res, next) => {
  // Skip if API keys are not enabled
  if (!config.developers?.keys?.enabled) return next();

  const apiKeyHeader = req.headers['x-api-key'];
  if (!apiKeyHeader) return next();

  // Only intercept tokens with the trawl_ prefix
  if (!apiKeyHeader.startsWith(KEY_PREFIX)) return next();

  try {
    const apiKey = await ApiKeyService.authenticate(apiKeyHeader);
    if (!apiKey) {
      return responses.error(res, 401, 'Unauthorized', 'Invalid or expired API key')({});
    }

    req.organization = { _id: apiKey.organizationId };
    req.apiKeyAuth = true;
    return next();
  } catch (err) {
    return responses.error(res, 500, 'Internal Server Error', 'API key authentication failed')(err);
  }
};

export default authenticateApiKey;
