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
 * @description Conditionally transition a subscription to 'unpaid' and downgrade plan to 'free'.
 *              Guards on status='past_due' AND pastDueSince <= threshold to prevent overwriting
 *              a subscription recovered by invoice.payment_succeeded between the dunning find and update.
 *              Returns null when the condition no longer matches (subscription already recovered).
 * @param {string} id - The subscription ObjectId (string).
 * @param {Date} threshold - Only mark unpaid when pastDueSince <= threshold.
 * @returns {Promise<Object|null>} The updated subscription document, null if id is invalid or condition unmet.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const markUnpaid = (id, threshold) => {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  if (!(threshold instanceof Date)) throw new TypeError('threshold must be a Date instance');
  return Subscription.findOneAndUpdate(
    { _id: id, status: 'past_due', pastDueSince: { $lte: threshold } },
    { $set: { status: 'unpaid', plan: 'free' } },
    { returnDocument: 'after', runValidators: true },
  ).exec();
};

/**
 * @function updateIfEventNewer
 * @description Atomically update a subscription only when the incoming Stripe event is newer
 *              than the last processed event for the given family.
 *              Prevents out-of-order webhook delivery from overwriting more-recent state.
 *              Same-second events are ordered by lex-string comparison of event IDs (evt_ prefix
 *              makes these globally deterministic within a second) — V5 P1 #2 tiebreaker.
 *
 *              The `family` parameter scopes the event-ordering guard to either the
 *              'subscription' family (customer.subscription.*) or the 'invoice' family
 *              (invoice.*).  Same-second cross-family deliveries no longer cancel each other.
 *
 *              Returns null when the guard prevents the write (stale event).
 * @param {string} id - The subscription ObjectId (string).
 * @param {number} eventCreatedAt - Stripe event.created Unix timestamp (seconds).
 * @param {string} eventId - Stripe event.id (e.g. evt_xxx) — tiebreaker for same-second delivery.
 * @param {Object} fields - Fields to $set on the document.
 * @param {'subscription'|'invoice'} [family='subscription'] - Event family to scope the ordering guard.
 * @returns {Promise<Object|null>} Updated doc, or null if id invalid or event is stale.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const updateIfEventNewer = (id, eventCreatedAt, eventId, fields, family = 'subscription') => {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;

  const createdAtField = family === 'invoice' ? 'lastInvoiceEventCreatedAt' : 'lastSubscriptionEventCreatedAt';
  const eventIdField = family === 'invoice' ? 'lastInvoiceEventId' : 'lastSubscriptionEventId';

  return Subscription.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { [createdAtField]: { $exists: false } },
        { [createdAtField]: null },
        { [createdAtField]: { $lt: eventCreatedAt } },
        {
          [createdAtField]: eventCreatedAt,
          $or: [
            { [eventIdField]: { $exists: false } },
            { [eventIdField]: null },
            { [eventIdField]: { $lt: eventId } },
          ],
        },
      ],
    },
    {
      $set: {
        ...fields,
        [createdAtField]: eventCreatedAt,
        [eventIdField]: eventId,
        // Legacy fields stripeEventCreatedAt/stripeEventId are no longer written.
        // The migration in trawl_node $unset them post-deploy so docs converge to
        // per-family markers only. Reading the legacy fields anywhere is dead surface.
      },
    },
    { returnDocument: 'after', runValidators: true },
  )
    .populate(defaultPopulate)
    .exec();
};

/**
 * @function adminUpdatePlanOnly
 * @description Restricted admin update — sets ONLY `plan` and `adminUpdatedAt`. Never touches
 *              `status`, `stripeCustomerId`, `stripeSubscriptionId`, `currentPeriodStart`, or
 *              the per-family event-ordering markers. Webhook handlers retain exclusive write
 *              authority on those fields via `updateIfEventNewer`.
 *
 *              Why this restriction matters: a free `update()` call with `{ plan, status }` from
 *              an admin path would overwrite Stripe-driven status (active/past_due/etc.) with
 *              whatever the admin sent, breaking dunning + access control. Splitting the surface
 *              forces admin overrides to plan-only territory.
 *
 * @param {string} id - Subscription ObjectId (string).
 * @param {string} planId - The new plan identifier (must be in config.billing.plans enum).
 * @param {string} adminUserId - The admin user ObjectId (string) who triggered the bump (for audit).
 * @returns {Promise<Object|null>} Updated subscription doc, or null if id is invalid.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const adminUpdatePlanOnly = (id, planId, adminUserId) => {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return Subscription.findByIdAndUpdate(
    id,
    {
      $set: {
        plan: planId,
        adminUpdatedAt: new Date(),
        adminUpdatedBy: adminUserId,
      },
    },
    { returnDocument: 'after', runValidators: true },
  )
    .populate(defaultPopulate)
    .exec();
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
  findAllDueForResetByLastReset,
  updateLastResetAt,
  findStaleDunning,
  markUnpaid,
  updateIfEventNewer,
  adminUpdatePlanOnly,
};
