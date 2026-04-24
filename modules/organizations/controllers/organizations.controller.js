/**
 * Module dependencies
 */
import jwt from 'jsonwebtoken';
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import config from '../../../config/index.js';
import mailer from '../../../lib/helpers/mailer/index.js';
import policy from '../../../lib/middlewares/policy.js';
import serializeAbilities from '../../../lib/helpers/abilities.js';
import OrganizationsService from '../services/organizations.crud.service.js';
import MembershipService from '../services/organizations.membership.service.js';
import AnalyticsService from '../../../lib/services/analytics.js';

const tokenCookieOptions = {
  httpOnly: true,
  secure: config.cookie.secure,
  sameSite: config.cookie.sameSite,
};

/**
 * @function list
 * @description Endpoint to fetch the list of organizations the current user belongs to.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const list = async (req, res) => {
  try {
    const organizations = await OrganizationsService.listByUser(req.user);
    responses.success(res, 'organization list')(organizations);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function create
 * @description Endpoint to create a new organization. The creator becomes the owner.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const create = async (req, res) => {
  try {
    const organization = await OrganizationsService.create(req.body, req.user);

    // Analytics groupIdentify — fire-and-forget, never break org flow
    try {
      AnalyticsService.groupIdentify('company', String(organization._id || organization.id), {
        name: organization.name,
        createdAt: organization.createdAt,
      });
    } catch (_) { /* analytics must not break org creation */ }

    responses.success(res, 'organization created')(organization);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function get
 * @description Endpoint to fetch the current organization loaded by the param middleware.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const get = (req, res) => {
  const organization = req.organization ? req.organization.toJSON() : {};
  responses.success(res, 'organization get')(organization);
};

/**
 * @function update
 * @description Endpoint to update an existing organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const update = async (req, res) => {
  try {
    const organization = await OrganizationsService.update(req.organization, req.body);

    // Analytics groupIdentify — fire-and-forget, never break org flow
    try {
      AnalyticsService.groupIdentify('company', String(organization._id || organization.id), {
        name: organization.name,
      });
    } catch (_) { /* analytics must not break org update */ }

    responses.success(res, 'organization updated')(organization);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function remove
 * @description Endpoint to delete an existing organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const remove = async (req, res) => {
  try {
    // UX protection: prevent a regular user from deleting their own last organization.
    // Global platform admins bypass this entirely (moderation); a member of multiple orgs
    // is also safe to delete the current one since they keep at least one membership.
    const isGlobalAdmin = Array.isArray(req.user?.roles) && req.user.roles.includes('admin');
    const isMemberOfTarget = !!req.membership;
    if (!isGlobalAdmin && isMemberOfTarget) {
      const userMemberships = await MembershipService.listByUser(req.user._id || req.user.id);
      if (userMemberships.length <= 1) {
        return responses.error(res, 422, 'Unprocessable Entity', 'You cannot delete your last organization')();
      }
    }
    const result = await OrganizationsService.remove(req.organization);
    responses.success(res, 'organization deleted')({ id: req.organization.id, ...result });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function adminList
 * @description Platform admin endpoint to list all organizations.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const adminList = async (req, res) => {
  try {
    const organizations = await OrganizationsService.list(req.search, req.page, req.perPage);
    const orgIds = organizations.map((org) => org._id || org.id);
    // Batch count members for all orgs in a single query
    const counts = await MembershipService.aggregateCountByOrganizations(orgIds);
    const countMap = Object.fromEntries(counts.map((c) => [String(c._id), c.count]));
    const enriched = organizations.map((org) => {
      const obj = org.toJSON ? org.toJSON() : { ...org };
      obj.memberCount = countMap[String(obj._id || obj.id)] || 0;
      return obj;
    });
    responses.success(res, 'organization list')(enriched);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function organizationByPage
 * @description Middleware to parse pagination params for admin org listing.
 */
const organizationByPage = async (req, res, next, params) => {
  try {
    if (!params) return responses.error(res, 404, 'Not Found', 'No params provided')();
    const request = params.split('&');
    if (request.length > 3) return responses.error(res, 422, 'Unprocessable Entity', 'Too many params')();
    if (request.length === 3) {
      req.page = Number(request[0]);
      req.perPage = Number(request[1]);
      req.search = String(request[2]);
    } else if (request.length === 2) {
      req.page = Number(request[0]);
      req.perPage = Number(request[1]);
    } else {
      req.page = 0;
      req.perPage = 0;
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * @function search
 * @description Endpoint to search organizations by name.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const search = async (req, res) => {
  try {
    // Block domain search for unverified users when mailer is configured
    if (mailer.isConfigured() && !req.user.emailVerified) {
      return responses.success(res, 'organization search')([]);
    }
    const organizations = await OrganizationsService.searchByDomain(req.user.email);
    responses.success(res, 'organization search')(organizations);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function organizationByID
 * @description Middleware to fetch an organization by its ID from the service.
 * Also loads the current user's membership for this organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @param {String} id - ID of the organization to fetch
 * @returns {void}
 */
const organizationByID = async (req, res, next, id) => {
  try {
    const organization = await OrganizationsService.get(id);
    if (!organization) responses.error(res, 404, 'Not Found', 'No Organization with that identifier has been found')();
    else {
      req.organization = organization;
      // Load user's membership for this organization if authenticated
      if (req.user) {
        req.membership = await MembershipService.findByUserAndOrganization(req.user._id || req.user.id, id);
      }
      next();
    }
  } catch (err) {
    next(err);
  }
};

/**
 * @function switchOrganization
 * @description Endpoint to switch the authenticated user's current organization context.
 * The organization is already loaded by the organizationByID param middleware.
 * Verifies the user has a membership on the target organization, updates
 * user.currentOrganization in the DB, issues a new JWT cookie, builds abilities
 * for the new org context, and returns the updated user with abilities.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const switchOrganization = async (req, res) => {
  try {
    const organizationId = req.params.organizationId;

    // Verify organization exists (param middleware may have loaded it, but we check directly
    // since the param middleware runs before JWT auth and may not have req.user available)
    const organization = req.organization || await OrganizationsService.get(organizationId);
    if (!organization) {
      return responses.error(res, 404, 'Not Found', 'No Organization with that identifier has been found')();
    }

    // Switch organization (verifies membership and updates user.currentOrganization)
    const { user: updatedUser, membership } = await OrganizationsService.switchOrganization(req.user, organization._id || organization.id);

    // Issue a new JWT cookie
    const token = jwt.sign({ userId: updatedUser.id }, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });

    // Build abilities for the new org context
    const ability = await policy.defineAbilityFor(updatedUser, membership);
    const abilities = serializeAbilities(ability);

    return res
      .status(200)
      .cookie('TOKEN', token, tokenCookieOptions)
      .json({
        type: 'success',
        message: 'organization switched',
        data: {
          user: updatedUser,
          abilities,
          tokenExpiresIn: Date.now() + config.jwt.expiresIn * 1000,
        },
      });
  } catch (err) {
    if (err.code === 'FORBIDDEN') {
      return responses.error(res, 403, 'Forbidden', 'User is not a member of this organization')(err);
    }
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function leave
 * @description Endpoint to leave an organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const leave = async (req, res) => {
  try {
    const result = await MembershipService.leave(
      req.user._id || req.user.id,
      req.organization._id || req.organization.id,
    );
    responses.success(res, 'organization left')(result);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function loadMembership
 * @description Middleware to load the user's membership for the current organization.
 * Intended to run after passport authentication on routes where the organizationByID
 * param middleware may have run before req.user was available.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const loadMembership = async (req, res, next) => {
  if (req.organization && req.user && !req.membership) {
    try {
      req.membership = await MembershipService.findByUserAndOrganization(
        req.user._id || req.user.id,
        req.organization._id || req.organization.id,
      );
    } catch (_) { /* ignore — isAllowed will handle the missing membership */ }
  }
  next();
};

export default {
  list,
  create,
  get,
  update,
  remove,
  leave,
  search,
  adminList,
  organizationByID,
  organizationByPage,
  loadMembership,
  switchOrganization,
};
