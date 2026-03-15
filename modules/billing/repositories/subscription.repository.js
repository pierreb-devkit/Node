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
 * @function list
 * @description Data access operation to fetch all subscriptions from the database with an optional filter.
 * @param {Object} [filter] - Optional filter to apply to the query.
 * @returns {Array} An array of subscriptions.
 */
const list = (filter) => Subscription.find(filter).populate(defaultPopulate).sort('-createdAt').exec();

/**
 * @function create
 * @description Data access operation to create a new subscription in the database.
 * @param {Object} subscription - The subscription object to create.
 * @returns {Object} The created subscription.
 */
const create = (subscription) => new Subscription(subscription).save().then((doc) => doc.populate(defaultPopulate));

/**
 * @function get
 * @description Data access operation to fetch a single subscription by its ID.
 * @param {String} id - The ID of the subscription to fetch.
 * @returns {Object} The retrieved subscription or null if the ID is not valid.
 */
const get = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Subscription.findOne({ _id: id }).populate(defaultPopulate).exec();
};

/**
 * @function update
 * @description Data access operation to update an existing subscription in the database.
 * @param {Object} subscription - The subscription object containing the updated details.
 * @returns {Object} The updated subscription.
 */
const update = (subscription) => {
  if (subscription._id) {
    return Subscription.findByIdAndUpdate(subscription._id, subscription, { returnDocument: 'after', runValidators: true })
      .populate(defaultPopulate)
      .exec();
  }
  return new Subscription(subscription).save().then((doc) => doc.populate(defaultPopulate));
};

/**
 * @function remove
 * @description Data access operation to delete a single subscription by its ID.
 * @param {Object} subscription - The subscription object to delete.
 * @returns {Object} A confirmation of the deletion.
 */
const remove = (subscription) => Subscription.deleteOne({ _id: subscription.id }).exec();

/**
 * @function findByOrganization
 * @description Data access operation to fetch a subscription by organization ID.
 * @param {String} organizationId - The organization ID.
 * @returns {Object} The retrieved subscription or null.
 */
const findByOrganization = (organizationId) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;
  return Subscription.findOne({ organization: organizationId }).populate(defaultPopulate).exec();
};

/**
 * @function findByStripeCustomerId
 * @description Data access operation to fetch a subscription by Stripe customer ID.
 * @param {String} stripeCustomerId - The Stripe customer ID.
 * @returns {Object} The retrieved subscription or null.
 */
const findByStripeCustomerId = (stripeCustomerId) =>
  Subscription.findOne({ stripeCustomerId }).populate(defaultPopulate).exec();

export default {
  list,
  create,
  get,
  update,
  remove,
  findByOrganization,
  findByStripeCustomerId,
};
