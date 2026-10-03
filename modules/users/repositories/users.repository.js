/**
 * Module dependencies
 */
import mongoose from 'mongoose';

/**
 * @desc Escape regex-special characters in a user-provided string.
 * @param {String} str - The raw string to escape.
 * @returns {String} The escaped string safe for use in a RegExp.
 */
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @desc Normalize an email for an EXACT-MATCH query. Emails are stored lowercased
 * (schema `lowercase:true`) and uniqueness is enforced case-insensitively (E3
 * collation index), but Mongoose's `lowercase` setter does NOT apply to query
 * filters — so every exact-match lookup must lowercase the term itself, otherwise
 * a `User@x.com` lookup misses the stored `user@x.com` row.
 * Returns null for non-strings so callers can bail out safely instead of
 * accidentally embedding an operator object into a Mongo filter.
 * @param {String} email
 * @returns {String|null} the lowercased, trimmed email, or null if not a string
 */
const normalizeEmail = (email) => (typeof email === 'string' ? email.toLowerCase().trim() : null);

const User = mongoose.model('User');

/**
 * @desc Function to get all user in db
 * @param {String} search
 * @param {Int} page
 * @param {Int} perPage
 * @returns {Array}  users selected
 */
const list = (search, page, perPage) => {
  const filter = search
    ? {
        $or: [
          { firstName: { $regex: escapeRegex(search), $options: 'i' } },
          { lastName: { $regex: escapeRegex(search), $options: 'i' } },
          { email: { $regex: escapeRegex(search), $options: 'i' } },
        ],
      }
    : {};
  return User.find(filter)
    .limit(perPage)
    .skip(perPage * page || 0)
    .select('-password -providerData')
    .populate('currentOrganization', 'name')
    .sort('-createdAt')
    .exec();
};

/**
 * @desc Function to create a user in db
 * @param {Object} user
 * @returns {Object} user
 */
const create = (user) => new User(user).save();

/**
 * @desc Function to get a user from db by id, email, or token
 * @param {Object} user
 * @returns {Object} user
 */
const get = (user = {}) => {
  if (user.id && mongoose.Types.ObjectId.isValid(user.id)) return User.findOne({ _id: user.id }).exec();
  if (user.email) {
    const email = normalizeEmail(user.email);
    if (!email) return Promise.resolve(null);
    return User.findOne({ email }).exec();
  }
  if (user.resetPasswordToken) {
    return User.findOne({
      resetPasswordToken: user.resetPasswordToken,
      resetPasswordExpires: {
        $gt: Date.now(),
      },
    }).exec();
  }
  if (user.emailVerificationToken) {
    return User.findOne({
      emailVerificationToken: user.emailVerificationToken,
      emailVerificationExpires: {
        $gt: Date.now(),
      },
    }).exec();
  }
};

/**
 * @desc Function to get a search in db request
 * @param {Object} mongoose input request
 * @returns {Array} users
 */
const search = (input) => User.find(input).exec();

/**
 * @desc Function to update a user in db
 * @param {Object} user
 * @returns {Object} user
 */
const update = (user) => {
  if (user._id) {
    return User.findByIdAndUpdate(user._id, user, { returnDocument: 'after', runValidators: true }).exec();
  }
  return new User(user).save();
};

/**
 * @desc Atomically verify an email address: only a document whose
 *       emailVerificationToken matches, emailVerificationExpires is still in the
 *       future, AND email is a non-empty string is updated, in the SAME
 *       findOneAndUpdate that reads it — closing the read-then-write race where two
 *       concurrent requests for the same token both pass a separate read check and
 *       both provision a workspace. A second concurrent call, a replay after the
 *       token was already consumed, or a doc with no email (mirrors the previous
 *       controller-level `!user.email` guard), matches no document and returns null.
 * @param {String} token - The raw emailVerificationToken from the verification link.
 * @returns {Object|null} the updated user document, or null when the token is
 *   missing, unknown, expired, already consumed, or the account has no email.
 */
const consumeEmailVerificationToken = (token) => {
  if (!token) return Promise.resolve(null);
  return User.findOneAndUpdate(
    {
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: Date.now() },
      email: { $exists: true, $nin: [null, ''] },
    },
    {
      emailVerified: true,
      emailVerificationToken: null,
      emailVerificationExpires: null,
    },
    { returnDocument: 'after', runValidators: true },
  ).exec();
};

/**
 * @desc Atomically set one `emailPreferences` kind for a user (#4162). Used
 * by the public one-click unsubscribe route — the caller has already
 * verified the HMAC token and only needs the write. Tolerant of an
 * invalid/unknown id: returns null rather than letting an invalid ObjectId
 * string reach Mongoose and throw a CastError.
 * @param {String} userId - the user id (from a verified unsubscribe token)
 * @param {String} kind - email kind ('onboarding' | 'news')
 * @param {Boolean} value - the new preference value
 * @returns {Promise<Object|null>} the updated user document, or null when
 *   the id is invalid or no document matched it.
 */
const setEmailPreference = (userId, kind, value) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) return Promise.resolve(null);
  return User.findOneAndUpdate(
    { _id: userId },
    { $set: { [`emailPreferences.${kind}`]: value } },
    { returnDocument: 'after', runValidators: true },
  ).exec();
};

/**
 * @desc Function to remove a user from db by id or email
 * @param {Object} user
 * @returns {Object} confirmation of delete
 */
const remove = async (user) => {
  if (user && user.id && mongoose.Types.ObjectId.isValid(user.id)) return User.deleteOne({ _id: user.id }).exec();
  if (user && user.email) {
    const email = normalizeEmail(user.email);
    if (!email) return Promise.resolve({ deletedCount: 0 });
    return User.deleteOne({ email }).exec();
  }
  return { deletedCount: 0 };
};

/**
 * @desc Function to get collection stats
 * @returns {Promise<number>} estimated document count
 */
const stats = () => User.estimatedDocumentCount().exec();

/**
 * @desc Exact document count (countDocuments, not estimated) for cap enforcement
 * @param {Object} [filter] - optional Mongoose filter
 * @returns {Promise<number>} exact matching document count
 */
const count = (filter = {}) => User.countDocuments(filter).exec();

/**
 * @desc Function to push list of users in db
 * @param {[Object]} users
 * @param {[String]} filters
 * @returns {Object} locations
 */
const push = (users, filters) => {
  if (!Array.isArray(filters) || filters.length === 0) {
    throw new Error('push requires at least one filter field');
  }
  return User.bulkWrite(
    users.map((user) => {
      const missing = filters.filter((value) => user[value] == null || user[value] === '');
      if (missing.length) {
        throw new Error(`push requires ${missing.join(', ')} on every user`);
      }
      const filter = {};
      filters.forEach((value) => {
        filter[value] = user[value];
      });
      return {
        updateOne: {
          filter,
          update: { $set: user },
          upsert: true,
        },
      };
    }),
  );
};

/**
 * @desc Function to search users by name or email with a regex
 * @param {String} search - The search string
 * @returns {Array} matching user IDs
 */
const searchByNameOrEmail = (search) => {
  const regex = new RegExp(escapeRegex(search), 'i');
  return User.find({
    $or: [{ email: regex }, { firstName: regex }, { lastName: regex }],
  }).select('_id').exec();
};

/**
 * @desc Function to find a user by email address
 * @param {String} email - The email to search for
 * @returns {Promise<Object|null>} The matching user or null
 */
const findByEmail = (email) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return Promise.resolve(null);
  return User.findOne({ email: normalized }).exec();
};

/**
 * @desc Function to update a user by ID with a partial update object
 * @param {String} id - The user ID
 * @param {Object} data - Fields to update
 * @returns {Object} update result
 */
const updateById = (id, data) => User.updateOne({ _id: id }, data, { runValidators: true }).exec();

/**
 * @desc Function to find a user by ID, update, and return the populated document
 * @param {String} id - The user ID
 * @param {Object} data - Fields to update
 * @param {String|Array|Object} populateFields - Fields to populate
 * @returns {Object} updated user
 */
const findByIdAndUpdatePopulated = (id, data, populateFields) =>
  User.findByIdAndUpdate(id, data, { returnDocument: 'after', runValidators: true }).populate(populateFields).exec();

/**
 * @desc Function to find users matching a filter with optional field selection
 * @param {Object} filter - Mongoose filter
 * @param {String} [select] - Fields to select
 * @returns {Array} matching users
 */
const findWithFilter = (filter, select) => User.find(filter).select(select || '').exec();

/**
 * @desc Fetch one `_id`-ordered page of users matching a filter, projected down
 * to `select` (#4162 — UserService.announce's recipient fan-out). Each page is
 * its own query, re-filtered by `_id: { $gt: afterId }` — no server-side cursor
 * state — so a caller that does something slow (e.g. a sequential mail send)
 * between pages can never hit a MongoDB cursor idle-timeout. Returns `[]` once
 * the walk is exhausted.
 * @param {Object} filter - Mongoose filter (ANDed with the `_id` page bound)
 * @param {Object} [options]
 * @param {String} [options.afterId] - exclusive lower bound (`_id` of the last
 *   row from the previous page); omit for the first page
 * @param {Number} [options.limit] - page size (default 200)
 * @param {String} [options.select] - fields to select; callers MUST limit this
 *   to what they actually read (e.g. never password/providerData)
 * @returns {Promise<Array>} up to `limit` plain (lean) user objects, `_id`-ascending
 */
const findPage = (filter, { afterId, limit = 200, select } = {}) => {
  const pageFilter = afterId ? { ...filter, _id: { $gt: afterId } } : filter;
  return User.find(pageFilter)
    .select(select || '')
    .sort({ _id: 1 })
    .limit(limit)
    .lean()
    .exec();
};

/**
 * @desc Function to update multiple users matching a filter
 * @param {Object} filter - Mongoose filter
 * @param {Object} data - Fields to update
 * @returns {Object} update result
 */
const updateMany = (filter, data) => User.updateMany(filter, data, { runValidators: true }).exec();

/**
 * @desc Atomically attach an OAuth provider to an existing user matched by email.
 * Uses findOneAndUpdate to avoid TOCTOU races between concurrent OAuth callbacks.
 * Filter requires `emailVerified: true` so an unverified-squatter local signup
 * cannot be silently annexed by a later OAuth signin (issue #3504).
 * @param {string} email - The email to match
 * @param {string} provider - The OAuth provider key (e.g. 'google', 'apple')
 * @param {Object} providerData - The provider's identity data to store
 * @returns {Promise<Object|null>} Updated user document, or null when no match
 *   OR when a match exists but is not email-verified — the caller is expected
 *   to follow up with findByEmail to distinguish the two cases if it needs to
 *   return a specific error.
 */
const linkProviderByEmail = (email, provider, providerData) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return Promise.resolve(null);
  return User.findOneAndUpdate(
    { email: normalized, emailVerified: true },
    { $set: { [`additionalProvidersData.${provider}`]: providerData } },
    { returnDocument: 'after', runValidators: true },
  ).exec();
};

export default {
  list,
  create,
  get,
  search,
  update,
  consumeEmailVerificationToken,
  setEmailPreference,
  remove,
  stats,
  count,
  push,
  searchByNameOrEmail,
  findByEmail,
  updateById,
  findByIdAndUpdatePopulated,
  findWithFilter,
  findPage,
  updateMany,
  linkProviderByEmail,
};
