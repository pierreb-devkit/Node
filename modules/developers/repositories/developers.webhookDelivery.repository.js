/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const WebhookDelivery = mongoose.model('WebhookDelivery');

/**
 * @function list
 * @description List paginated delivery records for a given webhook.
 * @param {String} webhookId - The webhook ID
 * @param {Number} page - Page number (1-based)
 * @param {Number} perPage - Items per page
 * @returns {Promise<{ data: Array, total: Number }>}
 */
const list = async (webhookId, page = 1, perPage = 20) => {
  if (!mongoose.Types.ObjectId.isValid(webhookId)) return { data: [], total: 0 };
  const filter = { webhook: webhookId };
  const [data, total] = await Promise.all([
    WebhookDelivery.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .exec(),
    WebhookDelivery.countDocuments(filter).exec(),
  ]);
  return { data, total };
};

/**
 * @function create
 * @description Create a new webhook delivery record.
 * @param {Object} delivery - The delivery object
 * @returns {Promise<Object>}
 */
const create = (delivery) => new WebhookDelivery(delivery).save();

/**
 * @function update
 * @description Update a webhook delivery record (save pattern).
 * @param {Object} delivery - The delivery Mongoose document
 * @returns {Promise<Object>}
 */
const update = (delivery) => delivery.save();

/**
 * @function findPendingRetries
 * @description Find deliveries that are pending retry.
 * @returns {Promise<Array>}
 */
const findPendingRetries = () => WebhookDelivery.find({
  success: false,
  nextRetryAt: { $lte: new Date() },
  attempts: { $lt: 3 },
}).exec();

export default {
  list,
  create,
  update,
  findPendingRetries,
};
