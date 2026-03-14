/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import MembershipService from '../services/organizations.membership.service.js';

/**
 * @function create
 * @description Endpoint to create a pending membership (join request) for an organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const create = async (req, res) => {
  try {
    const membership = await MembershipService.createJoinRequest(
      req.user._id || req.user.id,
      req.organization._id || req.organization.id,
    );
    responses.success(res, 'membership request created')(membership);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function listPending
 * @description Endpoint to list pending join requests for an organization (owner/admin).
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const listPending = async (req, res) => {
  try {
    if (!req.membership || req.membership.role === 'member') {
      return responses.success(res, 'membership request list')([]);
    }
    const requests = await MembershipService.listPending(req.organization._id || req.organization.id);
    responses.success(res, 'membership request list')(requests);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function approve
 * @description Endpoint to approve a pending membership request.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const approve = async (req, res) => {
  try {
    const membership = await MembershipService.approveRequest(req.membershipRequest);
    if (!membership) {
      return responses.error(res, 409, 'Conflict', 'Membership request could not be approved')();
    }
    responses.success(res, 'membership request approved')(membership);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function reject
 * @description Endpoint to reject a pending membership request.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const reject = async (req, res) => {
  try {
    const membership = await MembershipService.rejectRequest(req.membershipRequest);
    responses.success(res, 'membership request rejected')(membership);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function listMine
 * @description Endpoint to list the authenticated user's own pending requests.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const listMine = async (req, res) => {
  try {
    const requests = await MembershipService.listPendingByUser(req.user._id || req.user.id);
    responses.success(res, 'membership request list')(requests);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function invite
 * @description Endpoint to invite a user to an organization by email.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const invite = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return responses.error(res, 422, 'Unprocessable Entity', 'Email is required')();
    const result = await MembershipService.invite(
      req.organization._id || req.organization.id,
      email,
      req.user,
    );
    responses.success(res, 'invitation sent')(result);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function acceptInvite
 * @description Endpoint to accept an organization invite by token.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const acceptInvite = async (req, res) => {
  try {
    const { token } = req.params;
    const membership = await MembershipService.acceptInvite(token, req.user._id || req.user.id);
    responses.success(res, 'invitation accepted')(membership);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function getInvite
 * @description Endpoint to get invite details by token.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const getInvite = async (req, res) => {
  try {
    const { token } = req.params;
    const membership = await MembershipService.getInvite(token);
    if (!membership) return responses.error(res, 404, 'Not Found', 'Invalid or expired invite')();
    responses.success(res, 'invite details')(membership);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function requestByID
 * @description Middleware to fetch a pending membership by its ID.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @param {String} id - The membership request ID
 * @returns {void}
 */
const requestByID = async (req, res, next, id) => {
  try {
    const membership = await MembershipService.get(id);
    const organizationId = String(req.organization._id || req.organization.id);
    const membershipOrgId = String(membership?.organizationId?._id || membership?.organizationId);
    if (!membership || membership.status !== 'pending' || membershipOrgId !== organizationId) {
      return responses.error(res, 404, 'Not Found', 'No pending request with that identifier has been found')();
    }
    req.membershipRequest = membership;
    next();
  } catch (err) {
    next(err);
  }
};

export default {
  create,
  listPending,
  approve,
  reject,
  listMine,
  invite,
  acceptInvite,
  getInvite,
  requestByID,
};
