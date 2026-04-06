/**
 * Module dependencies
 */
import _ from 'lodash';

import config from '../../../config/index.js';
import AuthService from '../../auth/services/auth.service.js';
import UserRepository from '../repositories/users.repository.js';
import MembershipService from '../../organizations/services/organizations.membership.service.js';
import OrganizationsCrudService from '../../organizations/services/organizations.crud.service.js';
import { MEMBERSHIP_ROLES } from '../../organizations/lib/constants.js';
import { removeSensitive } from '../utils/sanitizeUser.js';

/**
 * @desc Function to get all users in db
 * @param {String} search
 * @param {Int} page
 * @param {Int} perPage
 * @returns {Promise<Array>} users selected
 */
const list = async (search, page, perPage) => {
  const result = await UserRepository.list(search, page || 0, perPage || 20);
  return result.map((user) => removeSensitive(user));
};

/**
 * @desc Function to ask repository to create a user (define provider, check & hashpassword, save)
 * @param {Object} user
 * @returns {Promise<Object>} created user (sanitized)
 */
const create = async (user) => {
  // Set provider to local
  if (!user.provider) user.provider = 'local';
  // confirming to secure password policies
  if (user.password) {
    // done in model, let this comment for information if one day joi.zxcvbn is not ok / sufficient
    // const validPassword = zxcvbn(user.password);
    // if (!validPassword || !validPassword.score || validPassword.score < config.zxcvbn.minimumScore) {
    //   throw new AppError(`${validPassword.feedback.warning}. ${validPassword.feedback.suggestions.join('. ')}`);
    // }
    // When password is provided we need to make sure we are hashing it
    user.password = await AuthService.hashPassword(user.password);
  }
  const result = await UserRepository.create(user);
  // Remove sensitive data before return
  return removeSensitive(result);
};

/**
 * @desc Function to ask repository to search users by request
 * @param {Object} input - mongoose query input
 * @returns {Promise<Array>} matching users (sanitized)
 */
const search = async (input) => {
  const result = await UserRepository.search(input);
  return result.map((user) => removeSensitive(user));
};

/**
 * @desc Function to ask repository to get a user by id or email
 * @param {Object} user - object with id or email field
 * @returns {Promise<Object|null>} sanitized user or null
 */
const get = async (user) => {
  const result = await UserRepository.get(user);
  return removeSensitive(result);
};

/**
 * @desc Function to ask repository to get a user by id or email without filter data return (test & intern usage)
 * @param {Object} user - object with id or email field
 * @returns {Promise<Object|null>} full user document or null
 */
const getBrut = async (user) => {
  const result = await UserRepository.get(user);
  return result;
};

/**
 * @desc Function to ask repository to update a user
 * @param {Object} user - original user document
 * @param {Object} body - fields to update
 * @param {string} [option] - update mode: 'admin', 'recover', or undefined for user self-update
 * @returns {Promise<Object>} updated user (sanitized)
 */
const update = async (user, body, option) => {
  if (!option) user = _.assignIn(user, removeSensitive(body, config.whitelists.users.update));
  else if (option === 'admin') user = _.assignIn(user, removeSensitive(body, config.whitelists.users.updateAdmin));
  else if (option === 'recover') user = _.assignIn(user, removeSensitive(body, config.whitelists.users.recover));

  const result = await UserRepository.update(user);
  return removeSensitive(result);
};

/**
 * @desc Function to ask repository to sign terms for current user
 * @param {Object} user - original user document
 * @returns {Promise<Object>} updated user (sanitized)
 */
const terms = async (user) => {
  user = _.assignIn(user, { terms: new Date() });
  const result = await UserRepository.update(user);
  return removeSensitive(result);
};

/**
 * @desc Function to remove a user from db and clean up associated memberships/orgs
 * @param {Object} user - user document with _id or id field
 * @returns {Promise<Object>} deletion result
 */
const remove = async (user) => {
  const userId = user._id || user.id;

  // Clean up memberships and handle orphaned orgs before deleting the user
  const memberships = await MembershipService.listByUser(userId);
  for (const membership of memberships) {
    const orgId = membership.organizationId._id || membership.organizationId;
    if (membership.role === MEMBERSHIP_ROLES.OWNER) {
      // Check if this user is the only owner of the org
      const ownerCount = await MembershipService.count({ organizationId: orgId, role: MEMBERSHIP_ROLES.OWNER });
      if (ownerCount <= 1) {
        // Sole owner — delete the entire org and its memberships
        // Clear currentOrganization for affected users
        await UserRepository.updateMany({ currentOrganization: orgId }, { currentOrganization: null });
        await MembershipService.deleteMany({ organizationId: orgId });
        await OrganizationsCrudService.removeById(orgId);
        continue; // membership already deleted above
      }
    }
    // Delete this user's membership
    await MembershipService.deleteMany({ _id: membership._id });
  }

  const result = await UserRepository.remove(user);
  return result;
};

/**
 * @desc Function to get all stats of db
 * @returns {Promise<Object>} user statistics
 */
const stats = async () => {
  const result = await UserRepository.stats();
  return result;
};

/**
 * @desc Function to update a user by ID with a partial update object
 * @param {String} id - The user ID
 * @param {Object} data - Fields to update
 * @returns {Promise<Object>} update result
 */
const updateById = (id, data) => UserRepository.updateById(id, data);

/**
 * @desc Function to find users matching a filter with optional field selection
 * @param {Object} filter - Mongoose filter
 * @param {String} [select] - Fields to select
 * @returns {Promise<Array>} matching users
 */
const findWithFilter = (filter, select) => UserRepository.findWithFilter(filter, select);

/**
 * @desc Function to find a user by ID, update, and return the populated document
 * @param {String} id - The user ID
 * @param {Object} data - Fields to update
 * @param {String|Array|Object} populateFields - Fields to populate
 * @returns {Promise<Object>} updated user
 */
const findByIdAndUpdatePopulated = (id, data, populateFields) => UserRepository.findByIdAndUpdatePopulated(id, data, populateFields);

/**
 * @desc Function to search users by name or email
 * @param {String} search - The search string
 * @returns {Promise<Array>} matching user IDs
 */
const searchByNameOrEmail = (search) => UserRepository.searchByNameOrEmail(search);

/**
 * @desc Function to find a user by email address
 * @param {String} email - The email to search for
 * @returns {Promise<Object|null>} The matching user or null
 */
const findByEmail = (email) => UserRepository.findByEmail(email);

export default {
  list,
  create,
  search,
  get,
  getBrut,
  update,
  terms,
  remove,
  stats,
  updateById,
  findWithFilter,
  findByIdAndUpdatePopulated,
  searchByNameOrEmail,
  findByEmail,
  removeSensitive,
};
