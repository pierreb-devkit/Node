/**
 * Module dependencies
 */
import crypto from 'crypto';
import MembershipRepository from '../repositories/organizations.membership.repository.js';

/**
 * @function list
 * @description Service to retrieve all memberships for an organization.
 * @param {String} organizationId - The ID of the organization.
 * @returns {Promise<Array>} A promise that resolves to the list of memberships.
 */
const list = async (organizationId) => {
  const result = await MembershipRepository.list({ organizationId });
  return Promise.resolve(result);
};

/**
 * @function get
 * @description Service to fetch a single membership by its ID.
 * @param {String} id - The ID of the membership to fetch.
 * @returns {Promise<Object|null>} A promise resolving to the retrieved membership.
 */
const get = async (id) => {
  const result = await MembershipRepository.get(id);
  return Promise.resolve(result);
};

/**
 * @function findByUserAndOrganization
 * @description Service to find a membership by user and organization.
 * @param {String} userId - The ID of the user.
 * @param {String} organizationId - The ID of the organization.
 * @returns {Promise<Object|null>} A promise resolving to the membership or null.
 */
const findByUserAndOrganization = async (userId, organizationId) => {
  const result = await MembershipRepository.findOne({ userId, organizationId });
  return Promise.resolve(result);
};

/**
 * @function invite
 * @description Service to create an invitation for a user by email. Generates an
 * invitation token with an expiry timestamp.
 * @param {String} organizationId - The ID of the organization.
 * @param {String} email - The email of the user to invite.
 * @param {String} role - The role to assign to the invited user.
 * @returns {Promise<Object>} A promise resolving to the invitation details including token.
 */
const invite = async (organizationId, email, role) => {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  return Promise.resolve({
    organizationId,
    email,
    role: role || 'member',
    token,
    expiresAt,
  });
};

/**
 * @function create
 * @description Service to create a membership directly.
 * @param {Object} data - Membership data containing userId, organizationId, and role.
 * @returns {Promise<Object>} A promise resolving to the created membership.
 */
const create = async (data) => {
  const result = await MembershipRepository.create(data);
  return Promise.resolve(result);
};

/**
 * @function updateRole
 * @description Service to update the role of an existing membership.
 * @param {Object} membership - The existing membership object.
 * @param {String} role - The new role to assign.
 * @returns {Promise<Object>} A promise resolving to the updated membership.
 */
const updateRole = async (membership, role) => {
  membership.role = role;
  const result = await MembershipRepository.update(membership);
  return Promise.resolve(result);
};

/**
 * @function remove
 * @description Service to delete a membership.
 * @param {Object} membership - The membership to delete.
 * @returns {Promise<Object>} A promise resolving to a confirmation of the deletion.
 */
const remove = async (membership) => {
  const result = await MembershipRepository.remove(membership);
  return Promise.resolve(result);
};

export default {
  list,
  get,
  findByUserAndOrganization,
  invite,
  create,
  updateRole,
  remove,
};
