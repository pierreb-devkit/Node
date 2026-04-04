/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const ApiKey = mongoose.model('ApiKey');

/**
 * @function list
 * @description Fetch paginated API keys for an organization (non-revoked).
 * @param {String} organizationId - The organization ID
 * @param {Number} page - Page number (1-based)
 * @param {Number} perPage - Items per page
 * @returns {Promise<{ data: Array, total: Number }>}
 */
const list = async (organizationId, page = 1, perPage = 20) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return { data: [], total: 0 };
  const filter = { organizationId, revoked: false };
  const [data, total] = await Promise.all([
    ApiKey.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .exec(),
    ApiKey.countDocuments(filter).exec(),
  ]);
  return { data, total };
};

/**
 * @function create
 * @description Create a new API key.
 * @param {Object} apiKey - The API key object
 * @returns {Promise<Object>} A promise resolving to the created API key
 */
const create = (apiKey) => new ApiKey(apiKey).save();

/**
 * @function get
 * @description Fetch a single API key by ID.
 * @param {String} id - The API key ID
 * @returns {Promise<Object|null>}
 */
const get = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return Promise.resolve(null);
  return ApiKey.findById(id).exec();
};

/**
 * @function revoke
 * @description Revoke (soft delete) an API key.
 * @param {String} id - The API key ID
 * @returns {Promise<Object|null>}
 */
const revoke = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return Promise.resolve(null);
  return ApiKey.findByIdAndUpdate(
    id,
    { revoked: true },
    { returnDocument: 'after' },
  ).exec();
};

/**
 * @function findByHashedKey
 * @description Find a non-revoked, non-expired API key by its hashed key.
 * @param {String} hashedKey - The SHA-256 hashed key
 * @returns {Promise<Object|null>}
 */
const findByHashedKey = (hashedKey) => ApiKey.findOne({
  hashedKey,
  revoked: false,
  $or: [
    { expiresAt: null },
    { expiresAt: { $gt: new Date() } },
  ],
}).exec();

/**
 * @function updateLastUsed
 * @description Update the lastUsedAt timestamp for an API key.
 * @param {String} id - The API key ID
 * @returns {Promise<Object|null>}
 */
const updateLastUsed = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return Promise.resolve(null);
  return ApiKey.findByIdAndUpdate(id, { lastUsedAt: new Date() }).exec();
};

export default {
  list,
  create,
  get,
  revoke,
  findByHashedKey,
  updateLastUsed,
};
