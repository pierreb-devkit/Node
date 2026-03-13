/**
 * Module dependencies
 */
import UserRepository from '../repositories/users.repository.js';

/**
 * @desc Function to ask repository to import a list of users
 * @param {[Object]} users
 * @param {[String]} filters
 * @return {Promise} users
 */
const push = (users, filters) => {
  const result = UserRepository.push(users, filters);
  return result;
};

export default {
  push,
};
