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
 * a `User@x.com` lookup misses the stored `user@x.com` row. No-op for non-strings.
 * @param {String} email
 * @returns {String} the lowercased, trimmed email (or the input unchanged if not a string)
 */
const normalizeEmail = (email) => (typeof email === 'string' ? email.toLowerCase().trim() : email);

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
  if (user.email) return User.findOne({ email: normalizeEmail(user.email) }).exec();
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
 * @desc Function to remove a user from db by id or email
 * @param {Object} user
 * @returns {Object} confirmation of delete
 */
const remove = async (user) => {
  if (user && user.id && mongoose.Types.ObjectId.isValid(user.id)) return User.deleteOne({ _id: user.id }).exec();
  if (user && user.email) return User.deleteOne({ email: normalizeEmail(user.email) }).exec();
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
const findByEmail = (email) => User.findOne({ email: normalizeEmail(email) }).exec();

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
const linkProviderByEmail = (email, provider, providerData) =>
  User.findOneAndUpdate(
    { email: normalizeEmail(email), emailVerified: true },
    { $set: { [`additionalProvidersData.${provider}`]: providerData } },
    { returnDocument: 'after', runValidators: true },
  ).exec();

export default {
  list,
  create,
  get,
  search,
  update,
  remove,
  stats,
  count,
  push,
  searchByNameOrEmail,
  findByEmail,
  updateById,
  findByIdAndUpdatePopulated,
  findWithFilter,
  updateMany,
  linkProviderByEmail,
};
