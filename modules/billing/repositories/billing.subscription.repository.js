/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Subscription = mongoose.model('Subscription');

const defaultPopulate = [
  {
    path: 'organization',
    select: 'name slug plan',
  },
];

/**
 * Resolves the identifier from a subscription object or raw id.
 * @param {Object|string} value - The subscription object or id string.
 * @returns {string|undefined} The resolved id.
 */
const resolveId = (value) => value?._id || value?.id || value;

/**
 * @function list
 * @description Data access operation to fetch all subscriptions from the database with an optional filter.
 * @param {Object} [filter] - Optional filter to apply to the query.
 * @returns {Promise<Array>} A promise resolving to an array of subscriptions.
 */
const list = (filter) => Subscription.find(filter).populate(defaultPopulate).sort('-createdAt').exec();

/**
 * @function create
 * @description Data access operation to create a new subscription in the database.
 * @param {Object} subscription - The subscription object to create.
 * @returns {Promise<Object>} A promise resolving to the created subscription.
 */
const create = (subscription) => new Subscription(subscription).save().then((doc) => doc.populate(defaultPopulate));

/**
 * @function get
 * @description Data access operation to fetch a single subscription by its ID.
 * @param {String} id - The ID of the subscription to fetch.
 * @returns {Promise<Object|null>} A promise resolving to the retrieved subscription or null if the ID is not valid.
 */
const get = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Subscription.findOne({ _id: id }).populate(defaultPopulate).exec();
};

/**
 * @function update
 * @description Data access operation to update an existing subscription in the database.
 * @param {Object} subscription - The subscription object containing the updated details.
 * @returns {Promise<Object>|null} A promise resolving to the updated subscription, or null if the ID is invalid.
 */
const update = (subscription) => {
  const id = resolveId(subscription);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  // eslint-disable-next-line no-unused-vars
  const { _id, id: _virtualId, ...payload } = subscription;
  return Subscription.findByIdAndUpdate(id, payload, { returnDocument: 'after', runValidators: true })
    .populate(defaultPopulate)
    .exec();
};

/**
 * @function remove
 * @description Data access operation to delete a single subscription by its ID.
 * @param {Object} subscription - The subscription object to delete.
 * @returns {Promise<Object|null>} A promise resolving to a confirmation of the deletion or null if invalid.
 */
const remove = (subscription) => {
  const id = resolveId(subscription);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return Subscription.deleteOne({ _id: id }).exec();
};

/**
 * @function findByOrganization
 * @description Data access operation to fetch a subscription by organization ID.
 * @param {String} organizationId - The organization ID.
 * @returns {Promise<Object|null>} A promise resolving to the retrieved subscription or null.
 */
const findByOrganization = (organizationId) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;
  return Subscription.findOne({ organization: organizationId }).populate(defaultPopulate).exec();
};

/**
 * @function findByStripeCustomerId
 * @description Data access operation to fetch a subscription by Stripe customer ID.
 * @param {String} stripeCustomerId - The Stripe customer ID.
 * @returns {Promise<Object|null>} A promise resolving to the retrieved subscription or null.
 */
const findByStripeCustomerId = (stripeCustomerId) => {
  const normalized = stripeCustomerId?.trim();
  if (!normalized) return null;
  return Subscription.findOne({ stripeCustomerId: normalized }).populate(defaultPopulate).exec();
};

export default {
  list,
  create,
  get,
  update,
  remove,
  findByOrganization,
  findByStripeCustomerId,
};
