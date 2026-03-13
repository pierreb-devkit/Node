/**
 * Module dependencies
 */
import _ from 'lodash';

import config from '../../../config/index.js';
import AuthService from '../../auth/services/auth.service.js';
import UserRepository from '../repositories/users.repository.js';
import MembershipService from '../../organizations/services/organizations.membership.service.js';
import OrganizationsCrudService from '../../organizations/services/organizations.crud.service.js';

/**
 * @desc Function to get all users in db
 * @param {String} search
 * @param {Int} page
 * @param {Int} perPage
 * @return {Promise} users selected
 */
const list = async (search, page, perPage) => {
  const result = await UserRepository.list(search, page || 0, perPage || 20);
  return Promise.resolve(result.map((user) => AuthService.removeSensitive(user)));
};

/**
 * @desc Function to ask repository to create a  user (define provider, check & haspassword, save)
 * @param {Object} user
 * @return {Promise} user
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
  return Promise.resolve(AuthService.removeSensitive(result));
};

/**
 * @desc Function to ask repository to search users by request
 * @param {Object} mongoose input request
 * @return {Array} users
 */
const search = async (input) => {
  const result = await UserRepository.search(input);
  return Promise.resolve(result.map((user) => AuthService.removeSensitive(user)));
};

/**
 * @desc Function to ask repository to get a user by id or email
 * @param {Object} user.id / user.email
 * @return {Object} user
 */
const get = async (user) => {
  const result = await UserRepository.get(user);
  return Promise.resolve(AuthService.removeSensitive(result));
};

/**
 * @desc Function to ask repository to get a user by id or email without filter data return (test & intern usage)
 * @param {Object} user.id / user.email
 * @return {Object} user
 */
const getBrut = async (user) => {
  const result = await UserRepository.get(user);
  return Promise.resolve(result);
};

/**
 * @desc Functio to ask repository to update a user
 * @param {Object} user - original user
 * @param {Object} body - user edited
 * @param {boolean} admin - true if admin update
 * @return {Promise} user -
 */
const update = async (user, body, option) => {
  if (!option) user = _.assignIn(user, AuthService.removeSensitive(body, config.whitelists.users.update));
  else if (option === 'admin') user = _.assignIn(user, AuthService.removeSensitive(body, config.whitelists.users.updateAdmin));
  else if (option === 'recover') user = _.assignIn(user, AuthService.removeSensitive(body, config.whitelists.users.recover));

  const result = await UserRepository.update(user);
  return Promise.resolve(AuthService.removeSensitive(result));
};

/**
 * @desc Functio to ask repository to sign terms for current user
 * @param {Object} user - original user
 * @return {Promise} user -
 */
const terms = async (user) => {
  user = _.assignIn(user, { terms: new Date() });
  const result = await UserRepository.update(user);
  return Promise.resolve(AuthService.removeSensitive(result));
};

/**
 * @desc Function to ask repository to a user from db by id or email
 * @param {Object} user
 * @return {Promise} result & id
 */
const remove = async (user) => {
  const userId = user._id || user.id;

  // Clean up memberships and handle orphaned orgs before deleting the user
  const memberships = await MembershipService.listByUser(userId);
  for (const membership of memberships) {
    const orgId = membership.organizationId._id || membership.organizationId;
    if (membership.role === 'owner') {
      // Check if this user is the only owner of the org
      const ownerCount = await MembershipService.count({ organizationId: orgId, role: 'owner' });
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
  return Promise.resolve(result);
};

/**
 * @desc Function to get all stats of db
 * @return {Promise} All stats
 */
const stats = async () => {
  const result = await UserRepository.stats();
  return Promise.resolve(result);
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
};
