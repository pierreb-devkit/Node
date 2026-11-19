/**
 * Module dependencies
 */
import _ from 'lodash';

import config from '../../../config/index.js';

/**
 * @desc Remove sensitive data from user object, returning only whitelisted keys.
 * @param {Object} user - Mongoose document or plain user object
 * @param {Array} [conf] - Optional list of keys to pick. Defaults to config.whitelists.users.default.
 * @returns {Object|null} sanitized user object or null
 */
const removeSensitive = (user, conf) => {
  if (!user || typeof user !== 'object') return null;
  const keys = conf || config.whitelists.users.default;
  const plain = typeof user.toJSON === 'function' ? user.toJSON() : user;
  return _.pick(plain, keys);
};

export { removeSensitive };
