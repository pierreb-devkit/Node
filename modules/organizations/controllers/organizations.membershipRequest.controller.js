/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import MembershipService from '../services/organizations.membership.service.js';
import { MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES, isOwnerApprovable } from '../lib/constants.js';

/**
 * @function create
 * @description Endpoint to create a pending membership (join request) for an organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
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
 * @returns {Promise<void>}
 */
const listPending = async (req, res) => {
  try {
    if (!req.membership || req.membership.role === MEMBERSHIP_ROLES.MEMBER) {
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
 * @returns {Promise<void>}
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
 * @description Endpoint to list the authenticated user's own pending JOIN REQUESTS
 *   (requests they initiated, awaiting an owner's approval). Owner_add invitations
 *   to accept are a separate surface — see listMinePending.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
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
 * @function listMinePending
 * @description Endpoint to list the authenticated user's pending OWNER_ADD
 *   invitations — memberships an owner/admin created for them that they must ACCEPT
 *   to activate. Feeds the Vue "pending invitations to accept" list (P5b).
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const listMinePending = async (req, res) => {
  try {
    const invitations = await MembershipService.listPendingOwnerAddsByUser(req.user._id || req.user.id);
    responses.success(res, 'membership invitation list')(invitations);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function accept
 * @description Endpoint for the INVITED USER to accept a pending owner_add membership.
 *   Authentication is required (passport); the consent gate lives in the service —
 *   acceptMembership activates ONLY when the membership is a PENDING owner_add AND
 *   belongs to the authenticated caller. A mismatch (wrong user, a join_request, an
 *   already-active or unknown membership) returns null → 404, never leaking which.
 *   No org membership / CASL check: the invitee is by definition NOT yet a member,
 *   so this route is intentionally outside the /members + /requests CASL surfaces.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const accept = async (req, res) => {
  try {
    const membership = await MembershipService.acceptMembership(
      req.params.membershipId,
      req.user._id || req.user.id,
    );
    if (!membership) {
      return responses.error(res, 404, 'Not Found', 'No pending invitation with that identifier has been found')();
    }
    responses.success(res, 'membership invitation accepted')(membership);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function decline
 * @description Endpoint for the INVITED USER to decline a pending owner_add
 *   membership — deletes the row (the user can be re-invited later). Same
 *   auth-only surface and consent gate as accept: the service returns null on any
 *   mismatch (wrong user, a join_request, an already-active or unknown
 *   membership) → 404, never leaking which condition failed.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const decline = async (req, res) => {
  try {
    const membership = await MembershipService.declineMembership(
      req.params.membershipId,
      req.user._id || req.user.id,
    );
    if (!membership) {
      return responses.error(res, 404, 'Not Found', 'No pending invitation with that identifier has been found')();
    }
    responses.success(res, 'membership invitation declined')(membership);
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
 * @returns {Promise<void>}
 */
const requestByID = async (req, res, next, id) => {
  try {
    const membership = await MembershipService.get(id);
    const organizationId = String(req.organization._id || req.organization.id);
    const membershipOrgId = String(membership?.organizationId?._id || membership?.organizationId);
    // CONSENT GATE (invariant #1): the owner-approval surface (approve/reject) must
    // ONLY ever see JOIN REQUESTS. An owner_add awaits the INVITED USER's consent —
    // it must be invisible here, else an owner could approve it and bypass consent.
    // `isOwnerApprovable` is the shared source of truth (covers join_request + the
    // E17 legacy no-source case); see its doc-level twin note on joinRequestSourceFilter.
    if (!membership || membership.status !== MEMBERSHIP_STATUSES.PENDING || !isOwnerApprovable(membership.source) || membershipOrgId !== organizationId) {
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
  listMinePending,
  accept,
  decline,
  requestByID,
};
