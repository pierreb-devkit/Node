/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import AppError from '../../../lib/helpers/AppError.js';
import OrganizationsRepository from '../repositories/organizations.repository.js';
import MembershipRepository from '../repositories/organizations.membership.repository.js';

/**
 * @function list
 * @description Service to retrieve all organizations in the database.
 * @returns {Promise<Array>} A promise that resolves to the list of all organizations.
 */
const list = async () => {
  const result = await OrganizationsRepository.list();
  return Promise.resolve(result);
};

/**
 * @function listByUser
 * @description Service to retrieve all organizations a user belongs to via memberships.
 * @param {Object} user - The authenticated user.
 * @returns {Promise<Array>} A promise that resolves to the list of organizations.
 */
const listByUser = async (user) => {
  const memberships = await MembershipRepository.list({ userId: user._id || user.id });
  const organizationIds = memberships.map((m) => m.organizationId._id || m.organizationId);
  const result = await OrganizationsRepository.list({ _id: { $in: organizationIds } });
  return Promise.resolve(result);
};

/**
 * @function create
 * @description Service to create a new organization and make the creator the owner.
 * @param {Object} body - The object containing organization details.
 * @param {Object} user - The user creating the organization.
 * @returns {Promise<Object>} A promise resolving to the newly created organization.
 */
const create = async (body, user) => {
  const organization = {
    name: body.name,
    slug: body.slug,
    domain: body.domain || '',
    plan: body.plan || 'free',
    createdBy: user.id || user._id,
  };

  const result = await OrganizationsRepository.create(organization);

  // Create owner membership for the creator
  await MembershipRepository.create({
    userId: user.id || user._id,
    organizationId: result._id,
    role: 'owner',
  });

  return Promise.resolve(result);
};

/**
 * @function get
 * @description Service to fetch a single organization by its ID.
 * @param {String} id - The ID of the organization to fetch.
 * @returns {Promise<Object|null>} A promise resolving to the retrieved organization.
 */
const get = async (id) => {
  const result = await OrganizationsRepository.get(id);
  return Promise.resolve(result);
};

/**
 * @function update
 * @description Service to update an existing organization.
 * @param {Object} organization - The existing organization object.
 * @param {Object} body - The object containing updated organization details.
 * @returns {Promise<Object>} A promise resolving to the updated organization.
 */
const update = async (organization, body) => {
  if (body.name !== undefined) organization.name = body.name;
  if (body.slug !== undefined) organization.slug = body.slug;
  if (body.domain !== undefined) organization.domain = body.domain;
  if (body.plan !== undefined) organization.plan = body.plan;

  const result = await OrganizationsRepository.update(organization);
  return Promise.resolve(result);
};

/**
 * @function remove
 * @description Service to delete an organization and all its memberships.
 * @param {Object} organization - The organization to delete.
 * @returns {Promise<Object>} A promise resolving to a confirmation of the deletion.
 */
const remove = async (organization) => {
  // Remove all memberships for this organization
  await MembershipRepository.deleteMany({ organizationId: organization._id || organization.id });
  const result = await OrganizationsRepository.remove(organization);
  return Promise.resolve(result);
};

/**
 * @function switchOrganization
 * @description Service to switch the user's current organization context.
 * Verifies the user has a membership on the target organization, updates
 * the user's currentOrganization field, and returns the updated user document.
 * @param {Object} user - The authenticated user (Mongoose document or plain object with id).
 * @param {String} organizationId - The ID of the organization to switch to.
 * @returns {Promise<Object>} A promise resolving to the updated user document with currentOrganization populated.
 */
const switchOrganization = async (user, organizationId) => {
  const User = mongoose.model('User');

  const membership = await MembershipRepository.findOne({
    userId: user._id || user.id,
    organizationId,
  });

  if (!membership) {
    throw new AppError('User is not a member of this organization', { code: 'FORBIDDEN' });
  }

  const updatedUser = await User.findByIdAndUpdate(
    user._id || user.id,
    { currentOrganization: organizationId },
    { new: true },
  ).populate('currentOrganization').exec();

  return { user: updatedUser, membership };
};

export default {
  list,
  listByUser,
  create,
  get,
  update,
  remove,
  switchOrganization,
};
