/**
 * Module dependencies
 */
import crypto from 'crypto';
import WebhookRepository from '../repositories/developers.webhook.repository.js';
import WebhookDeliveryRepository from '../repositories/developers.webhookDelivery.repository.js';

const SECRET_BYTE_LENGTH = 32;

/**
 * @function list
 * @description List webhooks for an organization (paginated).
 * @param {String} organizationId - The organization ID
 * @param {Number} page - Page number
 * @param {Number} perPage - Items per page
 * @returns {Promise<{ data: Array, total: Number }>}
 */
const list = (organizationId, page, perPage) => WebhookRepository.list(organizationId, page, perPage);

/**
 * @function create
 * @description Create a new webhook for a user within an organization.
 * @param {Object} body - { url, events, description }
 * @param {Object} user - The authenticated user
 * @param {String} organizationId - The organization ID
 * @returns {Promise<Object>} The created webhook with `plainSecret` (shown ONCE)
 */
const create = async (body, user, organizationId) => {
  const secret = `whsec_${crypto.randomBytes(SECRET_BYTE_LENGTH).toString('hex')}`;
  const doc = await WebhookRepository.create({
    url: body.url,
    events: body.events,
    secret,
    active: true,
    description: body.description || '',
    user: user._id,
    organizationId,
  });
  return { ...doc.toJSON(), plainSecret: secret };
};

/**
 * @function get
 * @description Fetch a single webhook by ID.
 * @param {String} id - The webhook ID
 * @returns {Promise<Object|null>}
 */
const get = (id) => WebhookRepository.get(id);

/**
 * @function update
 * @description Update a webhook by merging body fields onto the document.
 * @param {Object} webhook - The webhook Mongoose document
 * @param {Object} body - The update payload
 * @returns {Promise<Object>}
 */
const update = (webhook, body) => {
  if (body.url !== undefined) webhook.url = body.url;
  if (body.events !== undefined) webhook.events = body.events;
  if (body.active !== undefined) webhook.active = body.active;
  if (body.description !== undefined) webhook.description = body.description;
  return WebhookRepository.update(webhook);
};

/**
 * @function remove
 * @description Delete a webhook by ID.
 * @param {String} id - The webhook ID
 * @returns {Promise<Object|null>}
 */
const remove = (id) => WebhookRepository.remove(id);

/**
 * @function listDeliveries
 * @description List deliveries for a webhook (paginated).
 * @param {String} webhookId - The webhook ID
 * @param {Number} page - Page number
 * @param {Number} perPage - Items per page
 * @returns {Promise<{ data: Array, total: Number }>}
 */
const listDeliveries = (webhookId, page, perPage) => WebhookDeliveryRepository.list(webhookId, page, perPage);

export default {
  list,
  create,
  get,
  update,
  remove,
  listDeliveries,
};
