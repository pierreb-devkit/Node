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

/**
 * @function findByStripeSubscriptionId
 * @description Data access operation to fetch a subscription by Stripe subscription ID.
 * @param {String} stripeSubscriptionId - The Stripe subscription ID.
 * @returns {Promise<Object|null>} A promise resolving to the retrieved subscription or null.
 */
const findByStripeSubscriptionId = (stripeSubscriptionId) => {
  const normalized = stripeSubscriptionId?.trim();
  if (!normalized) return null;
  return Subscription.findOne({ stripeSubscriptionId: normalized }).populate(defaultPopulate).exec();
};

/**
 * @function findPlan
 * @description Lean lookup that returns only the `plan` field for a given organization.
 *              Used on hot paths (meter attribution, weekly reset) where only the plan
 *              identifier is needed — avoids the full populate overhead of findByOrganization.
 * @param {String} organizationId - The organization ID.
 * @returns {Promise<{plan: string}|null>} A lean plain object with just `plan`, or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const findPlan = (organizationId) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;
  return Subscription.findOne({ organization: organizationId }, { plan: 1 }).lean().exec();
};

/**
 * @function findAllDueForReset
 * @description Fetch active/trialing subscriptions whose currentPeriodStart falls
 *              within the provided time window. Used by the weekly meter reset sweep.
 *              Returns lean plain objects (no population) for performance.
 * @deprecated Prefer findAllDueForResetByLastReset() for scheduler-delay resilience.
 * @param {Date} from - The start of the window (inclusive).
 * @param {Date} to - The end of the window (inclusive).
 * @returns {Promise<Array<{organization: string, currentPeriodStart: Date}>>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const findAllDueForReset = (from, to) =>
  Subscription.find(
    {
      status: { $in: ['active', 'trialing'] },
      currentPeriodStart: { $gte: from, $lte: to },
    },
    { organization: 1, currentPeriodStart: 1 },
  ).lean();

/**
 * @function findAllDueForResetByLastReset
 * @description Fetch active/trialing subscriptions whose last successful reset is missing
 *              or older than 7 days. Filters out subscriptions without currentPeriodStart
 *              because resetWeek derives the next usage period from that timestamp.
 *              Returns lean plain objects (no population) for performance.
 * @param {Date} now - The current timestamp used to compute the stale-reset threshold.
 * @returns {Promise<Array<{organization: string, currentPeriodStart: Date, lastResetAt: Date|null}>>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const findAllDueForResetByLastReset = (now) => {
  if (!(now instanceof Date)) throw new TypeError('now must be a Date instance');
  const threshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  return Subscription.find(
    {
      status: { $in: ['active', 'trialing'] },
      currentPeriodStart: { $ne: null },
      $or: [
        { lastResetAt: null },
        { lastResetAt: { $lt: threshold } },
      ],
    },
    { organization: 1, currentPeriodStart: 1, lastResetAt: 1 },
  ).lean();
};

/**
 * @function updateLastResetAt
 * @description Update the last successful reset timestamp for a subscription by organization.
 * @param {string} organizationId - The organization ObjectId (string).
 * @param {Date} date - The timestamp to persist.
 * @returns {Promise<Object|null>} The updated subscription document, or null if the id is invalid.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const updateLastResetAt = (organizationId, date) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;
  if (!(date instanceof Date)) throw new TypeError('date must be a Date instance');

  return Subscription.findOneAndUpdate(
    { organization: organizationId },
    { $set: { lastResetAt: date } },
    { returnDocument: 'after', runValidators: true },
  ).exec();
};

/**
 * @function findStaleDunning
 * @description Fetch subscriptions with status 'past_due' whose pastDueSince is set
 *              and falls on or before the given threshold date.
 *              Used by the dunning sweep cron to transition stale past_due subs to 'unpaid'.
 *              Returns lean plain objects for performance.
 * @param {Date} threshold - Subscriptions with pastDueSince <= threshold are returned.
 * @returns {Promise<Array<{_id: string, organization: string}>>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const findStaleDunning = (threshold) => {
  if (!(threshold instanceof Date)) throw new TypeError('threshold must be a Date instance');
  return Subscription.find(
    {
      status: 'past_due',
      pastDueSince: { $ne: null, $lte: threshold },
    },
    { _id: 1, organization: 1 },
  ).lean();
};

/**
 * @function markUnpaid
 * @description Atomically transition a subscription to 'unpaid' and downgrade plan to 'free'.
 *              Idempotent: if the subscription is already unpaid the operation is effectively a no-op.
 * @param {string} id - The subscription ObjectId (string).
 * @returns {Promise<Object|null>} The updated subscription document or null if id is invalid.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const markUnpaid = (id) => {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return Subscription.findByIdAndUpdate(
    id,
    { $set: { status: 'unpaid', plan: 'free' } },
    { returnDocument: 'after', runValidators: true },
  ).exec();
};

export default {
  list,
  create,
  get,
  update,
  remove,
  findByOrganization,
  findPlan,
  findByStripeCustomerId,
  findByStripeSubscriptionId,
  findAllDueForReset,
  findAllDueForResetByLastReset,
  updateLastResetAt,
  findStaleDunning,
  markUnpaid,
};
