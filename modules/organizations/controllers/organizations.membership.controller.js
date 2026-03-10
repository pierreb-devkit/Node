/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import MembershipService from '../services/organizations.membership.service.js';

/**
 * @function list
 * @description Endpoint to fetch all members of an organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const list = async (req, res) => {
  try {
    const members = await MembershipService.list(req.organization._id);
    responses.success(res, 'membership list')(members);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function invite
 * @description Endpoint to invite a user to an organization by email.
 * Generates an invitation token with a 7-day expiry.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const invite = async (req, res) => {
  try {
    const invitation = await MembershipService.invite(req.organization._id, req.body.email, req.body.role);
    responses.success(res, 'invitation created')(invitation);
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
    if (!membership) responses.error(res, 404, 'Not Found', 'No Membership with that identifier has been found')();
    else {
      req.membershipDoc = membership;
      next();
    }
  } catch (err) {
    next(err);
  }
};

export default {
  list,
  invite,
  updateRole,
  remove,
  memberByID,
};
