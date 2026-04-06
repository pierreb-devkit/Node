/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import MembershipService from '../services/organizations.membership.service.js';
import { MEMBERSHIP_ROLES } from '../lib/constants.js';

/**
 * @function list
 * @description Endpoint to fetch all members of an organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const list = async (req, res) => {
  try {
    const page = req.query.page != null ? Number(req.query.page) : undefined;
    const perPage = req.query.perPage != null ? Number(req.query.perPage) : undefined;
    const search = req.query.search || undefined;
    const members = await MembershipService.list(req.organization._id, search, page, perPage);
    responses.success(res, 'membership list')(members);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function updateRole
 * @description Endpoint to change the role of a member in an organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const updateRole = async (req, res) => {
  try {
    // Belt-and-suspenders: only owners can change roles (CASL blocks admins via no 'update Membership')
    if (!req.membership || req.membership.role !== MEMBERSHIP_ROLES.OWNER) {
      return responses.error(res, 403, 'Forbidden', 'Only owners can change member roles')();
    }
    const membership = await MembershipService.updateRole(req.membershipDoc, req.body.role);
    responses.success(res, 'membership updated')(membership);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function remove
 * @description Endpoint to remove a member from an organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const remove = async (req, res) => {
  try {
    // Only owners can remove anyone; admins can only remove members
    const actorRole = req.membership?.role;
    const targetRole = req.membershipDoc.role;
    const canRemove = actorRole === MEMBERSHIP_ROLES.OWNER
      || (actorRole === MEMBERSHIP_ROLES.ADMIN && targetRole === MEMBERSHIP_ROLES.MEMBER);
    if (!canRemove) {
      return responses.error(res, 403, 'Forbidden', 'Insufficient permissions to remove this member')();
    }
    const result = await MembershipService.remove(req.membershipDoc);
    responses.success(res, 'membership deleted')({ id: req.membershipDoc.id, ...result });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function memberByID
 * @description Middleware to fetch a membership by its ID from the service.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @param {String} id - ID of the membership to fetch
 * @returns {void}
 */
const memberByID = async (req, res, next, id) => {
  try {
    const membership = await MembershipService.get(id);
    if (!membership) return responses.error(res, 404, 'Not Found', 'No Membership with that identifier has been found')();

    // Scope to the current organization to prevent cross-org manipulation
    const memberOrgId = String(membership.organizationId?._id || membership.organizationId);
    const reqOrgId = String(req.organization?._id || req.organization?.id);
    if (!reqOrgId || memberOrgId !== reqOrgId) {
      return responses.error(res, 404, 'Not Found', 'No Membership with that identifier has been found')();
    }

    req.membershipDoc = membership;
    next();
  } catch (err) {
    next(err);
  }
};

export default {
  list,
  updateRole,
  remove,
  memberByID,
};
