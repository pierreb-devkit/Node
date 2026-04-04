/**
 * Module dependencies
 */
import responses from '../../../lib/helpers/responses.js';
import ApiKeyService from '../services/developers.apiKey.service.js';

/**
 * @desc Endpoint to list API keys for the current organization
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const list = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.perPage, 10) || 20));
    const result = await ApiKeyService.list(req.organization._id, page, perPage);
    responses.success(res, 'ApiKeys')(result);
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to list API keys')(err);
  }
};

/**
 * @desc Endpoint to create a new API key
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const create = async (req, res) => {
  try {
    const result = await ApiKeyService.create(req.body, req.user, req.organization._id);
    responses.success(res, 'ApiKey created')(result);
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to create API key')(err);
  }
};

/**
 * @desc Endpoint to revoke an API key
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const revoke = async (req, res) => {
  try {
    await ApiKeyService.revoke(req.apiKey._id);
    responses.success(res, 'ApiKey revoked')({});
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to revoke API key')(err);
  }
};

/**
 * @desc Param middleware to load an API key by ID
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @param {String} id - The API key ID
 * @returns {Promise<void>}
 */
const apiKeyByID = async (req, res, next, id) => {
  try {
    const apiKey = await ApiKeyService.get(id);
    if (!apiKey) return responses.error(res, 404, 'Not Found', 'No API key with that identifier has been found')();
    req.apiKey = apiKey;
    return next();
  } catch (err) {
    return next(err);
  }
};

export default {
  list,
  create,
  revoke,
  apiKeyByID,
};
