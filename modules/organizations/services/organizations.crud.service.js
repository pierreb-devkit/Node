/**
 * Module dependencies
 */
import AppError from '../../../lib/helpers/AppError.js';
import config from '../../../config/index.js';

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
import OrganizationsRepository from '../repositories/organizations.repository.js';
import MembershipRepository from '../repositories/organizations.membership.repository.js';
import UserService from '../../users/services/users.service.js';
import { slugify } from '../helpers/organizations.slug.js';

/**
 * @function list
 * @description Service to retrieve all organizations in the database.
 * @returns {Promise<Array>} A promise that resolves to the list of all organizations.
 */
const list = async (search, page, perPage) => {
  const filter = search
    ? { $or: [{ name: { $regex: escapeRegex(search), $options: 'i' } }, { domain: { $regex: escapeRegex(search), $options: 'i' } }] }
    : {};
  const result = await OrganizationsRepository.list(filter, page, perPage);
  return result;
};

/**
 * @function listByUser
 * @description Service to retrieve all organizations a user belongs to via memberships.
 * @param {Object} user - The authenticated user.
 * @returns {Promise<Array>} A promise that resolves to the list of organizations.
 */
const listByUser = async (user) => {
  const memberships = await MembershipRepository.list({ userId: user._id || user.id, status: 'active' });
  const organizationIds = memberships.map((m) => m.organizationId._id || m.organizationId);
  const orgs = await OrganizationsRepository.list({ _id: { $in: organizationIds } });
  return orgs.map((org) => {
    const obj = org.toJSON ? org.toJSON() : { ...org };
    const membership = memberships.find((m) => String(m.organizationId._id || m.organizationId) === String(obj._id || obj.id));
    if (membership) obj.role = membership.role;
    return obj;
  });
};

/**
 * @function create
 * @description Service to create a new organization and make the creator the owner.
 * @param {Object} body - The object containing organization details.
 * @param {Object} user - The user creating the organization.
 * @returns {Promise<Object>} A promise resolving to the newly created organization.
 */
const create = async (body, user) => {
  // Auto-generate slug from name if not provided
  let slug = body.slug || slugify(body.name);
  let counter = 1;
  while (await OrganizationsRepository.findOne({ slug })) {
    slug = `${slugify(body.name)}-${counter}`;
    counter += 1;
  }

  // Auto-set domain from creator's email if not provided and not a public domain
  let domain = body.domain || '';
  if (!domain && user.email) {
    const emailDomain = user.email.split('@')[1]?.toLowerCase();
    const publicDomains = config.organizations?.publicDomains || [];
    if (emailDomain && !publicDomains.includes(emailDomain)) {
      domain = emailDomain;
    }
  }

  const organization = {
    name: body.name,
    description: body.description || '',
    slug,
    domain,
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

  // Set as user's current organization
  await UserService.updateById(user.id || user._id, { currentOrganization: result._id });

  return result;
};

/**
 * @function get
 * @description Service to fetch a single organization by its ID.
 * @param {String} id - The ID of the organization to fetch.
 * @returns {Promise<Object|null>} A promise resolving to the retrieved organization.
 */
const get = async (id) => {
  const result = await OrganizationsRepository.get(id);
  return result;
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
  if (body.description !== undefined) organization.description = body.description;
  if (body.slug !== undefined) {
    if (body.slug !== organization.slug) {
      const existing = await OrganizationsRepository.findOne({ slug: body.slug });
      if (existing) {
        throw new AppError('An organization with this slug already exists.', { code: 'CONFLICT' });
      }
    }
    organization.slug = body.slug;
  }
  if (body.domain !== undefined) organization.domain = body.domain;
  if (body.plan !== undefined) organization.plan = body.plan;

  const result = await OrganizationsRepository.update(organization);
  return result;
};

/**
 * @function remove
 * @description Service to delete an organization and all its memberships.
 * @param {Object} organization - The organization to delete.
 * @returns {Promise<Object>} A promise resolving to a confirmation of the deletion.
 */
const remove = async (organization) => {
  const orgId = organization._id || organization.id;

  // Find all users whose currentOrganization points to this org
  const affectedUsers = await UserService.findWithFilter({ currentOrganization: orgId }, '_id');

  // Remove all memberships for this organization
  await MembershipRepository.deleteMany({ organizationId: orgId });

  // For each affected user, switch to their next available org or set null
  for (const u of affectedUsers) {
    const remaining = await MembershipRepository.list({ userId: u._id });
    const nextOrg = remaining.length > 0
      ? (remaining[0].organizationId._id || remaining[0].organizationId)
      : null;
    await UserService.updateById(u._id, { currentOrganization: nextOrg });
  }

  // Delete all tasks belonging to this organization (Task module may not exist in all projects)
  try {
    const TasksService = (await import('../../tasks/services/tasks.service.js')).default;
    await TasksService.deleteMany({ organizationId: orgId });
  } catch (_err) {
    // Tasks module not available — skip cleanup
  }

  const result = await OrganizationsRepository.remove(organization);
  return result;
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
  const membership = await MembershipRepository.findOne({
    userId: user._id || user.id,
    organizationId,
    status: 'active',
  });

  if (!membership) {
    throw new AppError('User is not a member of this organization', { code: 'FORBIDDEN' });
  }

  const updatedUser = await UserService.findByIdAndUpdatePopulated(
    user._id || user.id,
    { currentOrganization: organizationId },
    'currentOrganization',
  );

  return { user: updatedUser, membership };
};

/**
 * @function autoSetCurrentOrganization
 * @description If the user has no currentOrganization but has active memberships,
 * sets the first one as current. Returns the (possibly updated) user.
 * @param {Object} user - The user object.
 * @returns {Promise<Object>} The user, with currentOrganization set if applicable.
 */
const autoSetCurrentOrganization = async (user) => {
  if (user.currentOrganization) {
    // Validate the membership still exists — it may have been removed by an admin
    const stillActive = await MembershipRepository.findOne({
      userId: user._id || user.id,
      organizationId: user.currentOrganization._id || user.currentOrganization,
      status: 'active',
    });
    if (stillActive) return user;
    // Membership gone — clear stale reference and fall through to find another
    user.currentOrganization = null;
  }
  const memberships = await MembershipRepository.list({ userId: user._id || user.id, status: 'active' });
  if (memberships.length > 0) {
    const orgId = memberships[0].organizationId._id || memberships[0].organizationId;
    await UserService.updateById(user._id || user.id, { currentOrganization: orgId });
    user.currentOrganization = orgId;
  } else {
    await UserService.updateById(user._id || user.id, { currentOrganization: null });
  }
  return user;
};

/**
 * @function searchByDomain
 * @description Search organizations matching the user's email domain.
 * Only returns orgs whose domain matches — prevents enumeration of all orgs.
 * Sensitive fields (createdBy, plan) are stripped from results.
 * @param {string} userEmail - The authenticated user's email.
 * @returns {Promise<Array>} Matching organizations (safe projection).
 */
const searchByDomain = async (userEmail) => {
  const emailDomain = userEmail?.split('@')[1]?.toLowerCase();
  if (!emailDomain) return [];
  const publicDomains = config.organizations?.publicDomains || [];
  if (publicDomains.includes(emailDomain)) return [];
  const orgs = await OrganizationsRepository.list({ domain: emailDomain }, 0, 5);
  return orgs.map((org) => {
    const obj = org.toJSON ? org.toJSON() : { ...org };
    delete obj.createdBy;
    delete obj.plan;
    return obj;
  });
};

/**
 * @function removeById
 * @description Service to delete an organization by ID without cascading cleanup.
 * @param {String} id - The ID of the organization to delete.
 * @returns {Promise<Object>} A confirmation of the deletion.
 */
const removeById = (id) => OrganizationsRepository.remove({ _id: id });

export default {
  list,
  listByUser,
  create,
  get,
  update,
  remove,
  switchOrganization,
  autoSetCurrentOrganization,
  searchByDomain,
  removeById,
};
