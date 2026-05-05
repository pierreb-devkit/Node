/**
 * Module dependencies
 */
import AppError from '../../../lib/helpers/AppError.js';
import { assertEmailVerified } from '../../../lib/helpers/emailVerification.js';
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';

/**
 * @desc Escape regex-special characters in a user-provided string.
 * @param {String} str - The raw string to escape.
 * @returns {String} The escaped string safe for use in a RegExp.
 */
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalize a domain string by trimming whitespace and lowercasing.
 * @param {String} [value=''] - Raw domain value.
 * @returns {String} Normalized domain.
 */
const normalizeDomain = (value = '') => value.trim().toLowerCase();

import OrganizationsRepository from '../repositories/organizations.repository.js';
import MembershipRepository from '../repositories/organizations.membership.repository.js';
import UserService from '../../users/services/users.service.js';
import { slugify } from '../helpers/organizations.slug.js';
import { MEMBERSHIP_STATUSES, MEMBERSHIP_ROLES } from '../lib/constants.js';

/**
 * @function list
 * @description Service to retrieve all organizations in the database.
 * @param {String} [search] - Optional search string to filter by name or domain.
 * @param {Number} [page] - Optional page number for pagination.
 * @param {Number} [perPage] - Optional items per page for pagination.
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
  const memberships = await MembershipRepository.list({ userId: user._id || user.id, status: MEMBERSHIP_STATUSES.ACTIVE });
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
 *   When mailer is configured, requires email verification first (throws AppError
 *   with code FORBIDDEN / status 403 if not verified).
 * @param {Object} body - The object containing organization details.
 * @param {Object} user - The user creating the organization.
 * @returns {Promise<Object>} A promise resolving to the newly created organization.
 * @throws {AppError} If mailer is configured and user email is not verified.
 */
const create = async (body, user) => {
  assertEmailVerified(user);

  // Auto-generate slug from name if not provided
  let slug = body.slug || slugify(body.name);
  let counter = 1;
  while (await OrganizationsRepository.findOne({ slug })) {
    slug = `${slugify(body.name)}-${counter}`;
    counter += 1;
  }

  const domain = normalizeDomain(body.domain);

  const organization = {
    name: body.name,
    description: body.description || '',
    slug,
    domain,
    plan: 'free',
    createdBy: user.id || user._id,
  };

  let result;
  try {
    result = await OrganizationsRepository.create(organization);
  } catch (err) {
    if (err?.code === 11000 && err?.keyPattern?.slug) {
      throw new AppError('An organization with this slug already exists. Please try again.', { code: 'CONFLICT' });
    }
    throw err;
  }

  // Create owner membership and set current org — rollback on failure
  let membership;
  try {
    membership = await MembershipRepository.create({
      userId: user.id || user._id,
      organizationId: result._id,
      role: MEMBERSHIP_ROLES.OWNER,
    });

    await UserService.updateById(user.id || user._id, { currentOrganization: result._id });
  } catch (err) {
    // Rollback partially created artifacts
    if (membership) await MembershipRepository.deleteMany({ _id: membership._id }).catch((e) => logger.error('organizations.crud.create: rollback membership failed', { message: e?.message, stack: e?.stack }));
    await OrganizationsRepository.remove(result).catch((e) => logger.error('organizations.crud.create: rollback organization failed', { message: e?.message, stack: e?.stack }));
    throw err;
  }

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
 * @description Service to update an existing organization using a sparse $set patch.
 *   The patch is constructed via an explicit allow-list so billing-owned fields (plan)
 *   are never included — they are written exclusively by the Stripe webhook path
 *   (setPlan / billing crons) and must never flow through this settings endpoint.
 * @param {Object} organization - The existing organization Mongoose document (for slug validation).
 * @param {Object} body - Zod-validated request body (already parsed by model.isValid middleware).
 * @returns {Promise<Object>} A promise resolving to the updated organization.
 */
const update = async (organization, body) => {
  // Build sparse patch from validated body via explicit allow-list.
  // Billing-owned fields (plan) are intentionally absent — they are written exclusively
  // by the Stripe webhook path (setPlan / billing crons).
  const patch = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;
  if (body.domain !== undefined) patch.domain = normalizeDomain(body.domain);

  // Slug: validate uniqueness before adding to patch.
  if (body.slug !== undefined) {
    if (body.slug !== organization.slug) {
      const existing = await OrganizationsRepository.findOne({ slug: body.slug });
      if (existing) {
        throw new AppError('An organization with this slug already exists.', { code: 'CONFLICT' });
      }
    }
    patch.slug = body.slug;
  }

  const orgId = organization._id || organization.id;
  const result = await OrganizationsRepository.updateById(String(orgId), patch);
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
  await Promise.all(affectedUsers.map(async (u) => {
    const remaining = await MembershipRepository.list({ userId: u._id, status: MEMBERSHIP_STATUSES.ACTIVE });
    const nextOrg = remaining.length > 0
      ? (remaining[0].organizationId._id || remaining[0].organizationId)
      : null;
    await UserService.updateById(u._id, { currentOrganization: nextOrg });
  }));

  // Delete all tasks belonging to this organization (Task module may not exist in all projects)
  try {
    const TasksService = (await import('../../tasks/services/tasks.service.js')).default;
    await TasksService.deleteMany({ organizationId: orgId });
  } catch (err) {
    // Only swallow module-not-found errors; re-throw data/runtime failures
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) {
      // Tasks module not available — skip cleanup
    } else {
      throw err;
    }
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
    status: MEMBERSHIP_STATUSES.ACTIVE,
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
      status: MEMBERSHIP_STATUSES.ACTIVE,
    });
    if (stillActive) return user;
    // Membership gone — clear stale reference and fall through to find another
    user.currentOrganization = null;
  }
  const memberships = await MembershipRepository.list({ userId: user._id || user.id, status: MEMBERSHIP_STATUSES.ACTIVE });
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
