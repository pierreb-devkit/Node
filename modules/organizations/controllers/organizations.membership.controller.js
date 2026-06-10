/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import isGlobalAdmin from '../../../lib/helpers/isGlobalAdmin.js';
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
 * @function findUserByEmail
 * @description Endpoint for an org owner/admin to look up a single user by EXACT
 *   email, to add them as a member (P5b affordance). GDPR/privacy: deliberately
 *   exact-match only (no fuzzy name enumeration of the user directory) and gated by
 *   the same owner/admin CASL `create Membership` ability the add-member route uses.
 *   Returns minimal identity (id, displayName, email) for a match, or null.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const findUserByEmail = async (req, res) => {
  try {
    // CASL on the GET /members surface grants `read Membership` to plain members too,
    // which is too broad for a user-directory lookup. Restrict to owner/admin (or
    // global admin) explicitly — only roles that can actually add a member.
    const isPlatformAdmin = isGlobalAdmin(req.user);
    const actorRole = req.membership?.role;
    const canEnumerate = isPlatformAdmin
      || actorRole === MEMBERSHIP_ROLES.OWNER
      || actorRole === MEMBERSHIP_ROLES.ADMIN;
    if (!canEnumerate) {
      return responses.error(res, 403, 'Forbidden', 'Only owners or admins can look up users')();
    }

    const email = req.query.email;
    if (!email || typeof email !== 'string') {
      return responses.error(res, 422, 'Unprocessable Entity', 'An email query parameter is required')();
    }
    const match = await MembershipService.findUserByExactEmail(email);
    responses.success(res, 'user lookup')(match);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function addMember
 * @description Endpoint for an org owner/admin to add a user as a member. Creates a
 *   PENDING owner_add membership the INVITED USER must accept (consent — invariant #1).
 *   Role gate mirrors updateRole: only OWNERS may grant owner/admin; admins may only
 *   add plain members. CASL (`create Membership`) on the /members POST route already
 *   restricts this to org owners/admins (+ global admins).
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const addMember = async (req, res) => {
  try {
    const { userId, role } = req.body;
    const requestedRole = role || MEMBERSHIP_ROLES.MEMBER;

    // Elevated-role guard: only owners (or global admins) may invite an owner/admin.
    const isPlatformAdmin = isGlobalAdmin(req.user);
    const actorIsOwner = req.membership?.role === MEMBERSHIP_ROLES.OWNER;
    if (requestedRole !== MEMBERSHIP_ROLES.MEMBER && !isPlatformAdmin && !actorIsOwner) {
      return responses.error(res, 403, 'Forbidden', 'Only owners can add a member with an elevated role')();
    }

    const membership = await MembershipService.addMember(
      req.organization._id || req.organization.id,
      userId,
      requestedRole,
      req.user._id || req.user.id,
    );
    responses.success(res, 'membership invitation created')(membership);
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
    // Belt-and-suspenders: only org owners can change roles (CASL blocks non-owner org
    // roles via no 'update Membership'). Global platform admins bypass the membership
    // requirement for moderation — notably to transfer ownership on a third-party org.
    // Note: `isPlatformAdmin` is the global/platform role (`user.roles.includes('admin')`),
    // distinct from the org-level `MEMBERSHIP_ROLES.ADMIN`.
    const isPlatformAdmin = isGlobalAdmin(req.user);
    if (!isPlatformAdmin && (!req.membership || req.membership.role !== MEMBERSHIP_ROLES.OWNER)) {
      return responses.error(res, 403, 'Forbidden', 'Only owners or global admins can change member roles')();
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
    // Only owners can remove anyone; admins can only remove members.
    // Global platform admins bypass org-level RBAC for moderation needs.
    // Note: `isPlatformAdmin` is the global/platform role, distinct from the
    // org-level `MEMBERSHIP_ROLES.ADMIN` referenced below.
    const isPlatformAdmin = isGlobalAdmin(req.user);
    const actorRole = req.membership?.role;
    const targetRole = req.membershipDoc.role;
    const canRemove = isPlatformAdmin
      || actorRole === MEMBERSHIP_ROLES.OWNER
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
  findUserByEmail,
  addMember,
  updateRole,
  remove,
  memberByID,
};
