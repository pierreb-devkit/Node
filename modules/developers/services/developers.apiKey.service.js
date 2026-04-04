/**
 * Module dependencies
 */
import crypto from 'crypto';
import ApiKeyRepository from '../repositories/developers.apiKey.repository.js';

const KEY_PREFIX = 'trawl_';
const RAW_BYTES = 20; // 20 bytes = 40 hex chars
const PREFIX_LENGTH = 12;

/**
 * @function list
 * @description List API keys for an organization (paginated).
 * @param {String} organizationId - The organization ID
 * @param {Number} page - Page number
 * @param {Number} perPage - Items per page
 * @returns {Promise<{ data: Array, total: Number }>}
 */
const list = (organizationId, page, perPage) => ApiKeyRepository.list(organizationId, page, perPage);

/**
 * @function create
 * @description Create a new API key for a user within an organization.
 * @param {Object} body - { name, scopes, expiresAt }
 * @param {Object} user - The authenticated user
 * @param {String} organizationId - The organization ID
 * @returns {Promise<Object>} The created key with `plainKey` (shown ONCE)
 */
const create = async (body, user, organizationId) => {
  const plainKey = KEY_PREFIX + crypto.randomBytes(RAW_BYTES).toString('hex');
  const hashedKey = crypto.createHash('sha256').update(plainKey).digest('hex');
  const prefix = plainKey.substring(0, PREFIX_LENGTH);

  const doc = await ApiKeyRepository.create({
    name: body.name,
    hashedKey,
    prefix,
    scopes: body.scopes || ['read'],
    expiresAt: body.expiresAt || null,
    user: user._id,
    organizationId,
  });

  return { ...doc.toJSON(), plainKey };
};

/**
 * @function get
 * @description Fetch a single API key by ID.
 * @param {String} id - The API key ID
 * @returns {Promise<Object|null>}
 */
const get = (id) => ApiKeyRepository.get(id);

/**
 * @function revoke
 * @description Revoke an API key.
 * @param {String} id - The API key ID
 * @returns {Promise<Object|null>}
 */
const revoke = (id) => ApiKeyRepository.revoke(id);

/**
 * @function authenticate
 * @description Authenticate a raw API key. Returns the key doc or null.
 * @param {String} plainKey - The full plain API key
 * @returns {Promise<Object|null>}
 */
const authenticate = async (plainKey) => {
  if (!plainKey || !plainKey.startsWith(KEY_PREFIX)) return null;
  const hashedKey = crypto.createHash('sha256').update(plainKey).digest('hex');
  const apiKey = await ApiKeyRepository.findByHashedKey(hashedKey);
  if (!apiKey) return null;
  // Fire-and-forget lastUsedAt update
  ApiKeyRepository.updateLastUsed(apiKey._id).catch((err) => console.error('Failed to update API key lastUsedAt:', err.message));
  return apiKey;
};

export default {
  list,
  create,
  get,
  revoke,
  authenticate,
};
