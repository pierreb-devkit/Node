/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import responses from '../../../lib/helpers/responses.js';
import ApiKeyService from '../services/developers.apiKey.service.js';

const KEY_PREFIX = 'trawl_';
const RATE_LIMIT_MS = 5000;

/**
 * In-memory rate limit tracker: apiKey _id → last request timestamp.
 * @type {Map<string, number>}
 */
const lastRequestByKey = new Map();

/**
 * @desc Middleware to authenticate requests via API key.
 * Checks `Authorization: Bearer trawl_...` header.
 * If valid, sets req.organization and req.apiKeyAuth.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 * @returns {void}
 */
const authenticateApiKey = async (req, res, next) => {
  // Skip if API keys are not enabled
  if (!config.developers?.keys?.enabled) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

  const token = authHeader.substring(7);
  // Only intercept tokens with the trawl_ prefix
  if (!token.startsWith(KEY_PREFIX)) return next();

  try {
    const apiKey = await ApiKeyService.authenticate(token);
    if (!apiKey) {
      return responses.error(res, 401, 'Unauthorized', 'Invalid or expired API key')({});
    }

    // Simple in-memory rate limit per key
    const keyId = String(apiKey._id);
    const now = Date.now();
    const lastRequest = lastRequestByKey.get(keyId);
    if (lastRequest && now - lastRequest < RATE_LIMIT_MS) {
      res.set('Retry-After', '5');
      return responses.error(res, 429, 'Too Many Requests', 'Rate limit exceeded')({});
    }
    lastRequestByKey.set(keyId, now);

    req.organization = { _id: apiKey.organizationId };
    req.apiKeyAuth = true;
    return next();
  } catch (err) {
    return responses.error(res, 500, 'Internal Server Error', 'API key authentication failed')(err);
  }
};

export default authenticateApiKey;
