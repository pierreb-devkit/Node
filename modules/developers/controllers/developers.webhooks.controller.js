/**
 * Module dependencies
 */
import responses from '../../../lib/helpers/responses.js';
import WebhookService from '../services/developers.webhook.service.js';
import WebhookDispatchService from '../services/developers.webhook.dispatch.service.js';

/**
 * @desc Endpoint to list webhooks for the current organization
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const list = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.perPage, 10) || 20));
    const result = await WebhookService.list(req.organization._id, page, perPage);
    responses.success(res, 'webhooks')(result);
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to list webhooks')(err);
  }
};

/**
 * @desc Endpoint to create a new webhook
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const create = async (req, res) => {
  try {
    const result = await WebhookService.create(req.body, req.user, req.organization._id);
    responses.success(res, 'webhook created')(result);
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to create webhook')(err);
  }
};

/**
 * @desc Endpoint to get a single webhook
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const get = (req, res) => {
  responses.success(res, 'webhook')(req.webhook);
};

/**
 * @desc Endpoint to update a webhook
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const update = async (req, res) => {
  try {
    const result = await WebhookService.update(req.webhook, req.body);
    responses.success(res, 'webhook updated')(result);
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to update webhook')(err);
  }
};

/**
 * @desc Endpoint to delete a webhook
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const remove = async (req, res) => {
  try {
    await WebhookService.remove(req.webhook._id);
    responses.success(res, 'webhook deleted')({});
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to delete webhook')(err);
  }
};

/**
 * @desc Endpoint to list deliveries for a webhook
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const listDeliveries = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.perPage, 10) || 20));
    const result = await WebhookService.listDeliveries(req.webhook._id, page, perPage);
    responses.success(res, 'webhook deliveries')(result);
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to list deliveries')(err);
  }
};

/**
 * @desc Endpoint to send a test ping to a webhook
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const testPing = async (req, res) => {
  try {
    const delivery = await WebhookDispatchService.sendTestPing(req.webhook);
    responses.success(res, 'test ping sent')(delivery);
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to send test ping')(err);
  }
};

/**
 * @desc Param middleware to load a webhook by ID
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @param {String} id - The webhook ID
 * @returns {Promise<void>}
 */
const webhookByID = async (req, res, next, id) => {
  try {
    const webhook = await WebhookService.get(id);
    if (!webhook) return responses.error(res, 404, 'Not Found', 'No webhook with that identifier has been found')();
    req.webhook = webhook;
    return next();
  } catch (err) {
    return next(err);
  }
};

export default {
  list,
  create,
  get,
  update,
  remove,
  listDeliveries,
  testPing,
  webhookByID,
};
