/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Webhook = mongoose.model('Webhook');

/**
 * @function list
 * @description Fetch paginated webhooks for an organization.
 * @param {String} organizationId - The organization ID
 * @param {Number} page - Page number (1-based)
 * @param {Number} perPage - Items per page
 * @returns {Promise<{ data: Array, total: Number }>}
 */
const list = async (organizationId, page = 1, perPage = 20) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return { data: [], total: 0 };
  const filter = { organizationId };
  const [data, total] = await Promise.all([
    Webhook.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .exec(),
    Webhook.countDocuments(filter).exec(),
  ]);
  return { data, total };
};

/**
 * @function create
 * @description Create a new webhook.
 * @param {Object} webhook - The webhook object
 * @returns {Promise<Object>}
 */
const create = (webhook) => new Webhook(webhook).save();

/**
 * @function get
 * @description Fetch a single webhook by ID.
 * @param {String} id - The webhook ID
 * @returns {Promise<Object|null>}
 */
const get = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Webhook.findById(id).exec();
};

/**
 * @function update
 * @description Update a webhook (save pattern).
 * @param {Object} webhook - The webhook Mongoose document
 * @returns {Promise<Object>}
 */
const update = (webhook) => webhook.save();

/**
 * @function remove
 * @description Delete a webhook by ID.
 * @param {String} id - The webhook ID
 * @returns {Promise<Object|null>}
 */
const remove = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Webhook.findByIdAndDelete(id).exec();
};

/**
 * @function findByEvent
 * @description Find all active webhooks subscribed to a given event within an organization.
 * @param {String} event - The event name
 * @param {String} organizationId - The organization ID
 * @returns {Promise<Array>}
 */
const findByEvent = (event, organizationId) => Webhook.find({ events: event, active: true, organizationId }).exec();

/**
 * @function findActiveByEvent
 * @description Find ALL active webhooks matching an event across all organizations.
 * @param {String} event - The event name
 * @returns {Promise<Array>}
 */
const findActiveByEvent = (event) => Webhook.find({ events: event, active: true }).exec();

export default {
  list,
  create,
  get,
  update,
  remove,
  findByEvent,
  findActiveByEvent,
};
