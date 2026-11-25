/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import isGlobalAdmin from '../../../lib/helpers/isGlobalAdmin.js';
import responses from '../../../lib/helpers/responses.js';
import logger from '../../../lib/services/logger.js';
import InvitationService from '../services/invitations.service.js';
import { canManageMembers, canGrantRole } from '../../organizations/lib/organizations.rights.js';
import { MEMBERSHIP_ROLES } from '../../organizations/lib/organizations.constants.js';

/**
 * @desc Serialize an invitation for an organization route — the token is never handed
 * to org owners/admins (it would let them complete a signup for an address they do not
 * own); the invitee gets it by email only.
 * @param {Object} invitation - invitation document
 * @returns {Object} plain invitation without `token`
 */
const withoutToken = (invitation) => {
  const plain = typeof invitation.toJSON === 'function' ? invitation.toJSON() : { ...invitation };
  delete plain.token;
  return plain;
};

/**
 * @desc Admin: create + email a signup invitation
 * @param {Object} req - Express request object
 * @param {Object} req.body - Request body
 * @param {string} req.body.email - Email address to invite
 * @param {Object} req.user - Authenticated admin user
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with created invitation, 409 on duplicate pending, or the error's own status (500 when it has none)
 */
const create = async (req, res) => {
  try {
    const invitation = await InvitationService.create(req.body.email, req.user);
    responses.success(res, 'invitation created')(invitation);
  } catch (err) {
    responses.error(res, undefined, undefined, errors.getMessage(err))(err);
  }
};

/**
 * @desc List signup invitations — role-keyed by the service (#3833):
 * admins get the platform-global list, any other caller only their own.
 * @param {Object} req - Express request object
 * @param {Object} req.user - Authenticated caller (scoping key)
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with invitation array or the error's own status (500 when it has none)
 */
const list = async (req, res) => {
  try {
    const invitations = await InvitationService.list(req.user);
    responses.success(res, 'invitation list')(invitations);
  } catch (err) {
    responses.error(res, undefined, undefined, errors.getMessage(err))(err);
  }
};

/**
 * @desc Admin: revoke a PENDING invitation (pending-only guard in the repository)
 * @param {Object} req - Express request object
 * @param {Object} req.invitation - Loaded invitation document (set by invitationByID middleware)
 * @param {string} req.invitation.id - Invitation id
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with deleted id, 409 when not pending, or the error's own status (500 when it has none)
 */
const remove = async (req, res) => {
  try {
    const revoked = await InvitationService.revoke(req.invitation.id);
    if (!revoked) {
      // The invitation EXISTS (invitationByID loaded it) but the guarded CAS
      // matched nothing → it is no longer pending (accepted or already
      // revoked). Refuse: revoking an accepted invite would silently drop it
      // from the accepted set used for referral attribution.
      return responses.error(res, 409, 'Conflict', 'Only pending invitations can be revoked')();
    }
    responses.success(res, 'invitation deleted')({ id: req.invitation.id });
  } catch (err) {
    responses.error(res, undefined, undefined, errors.getMessage(err))(err);
  }
};

/**
 * @desc Admin: re-send the invitation email for a pending invitation (existing token).
 * Explicitly admin-gated regardless of `config.invitations.userFacing` (#3945): CASL
 * has no per-document Invitation subject registered, and this POST route resolves to
 * the SAME 'create' action (methodToAction) as new-invitation creation — a widened
 * non-admin 'create' grant would otherwise also open resend to ANY invitation, not just
 * the caller's own. This is the defense-in-depth mirror (see invitations.policy.js).
 * @param {Object} req - Express request object
 * @param {Object} req.user - Authenticated caller
 * @param {Object} req.invitation - Loaded invitation document (set by invitationByID middleware)
 * @param {string} req.invitation.id - Invitation id
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with the invitation, 403 when not admin, 409 when not pending, or the error's own status (500 when it has none)
 */
const resend = async (req, res) => {
  if (!isGlobalAdmin(req.user)) {
    return responses.error(res, 403, 'Forbidden', 'Only platform admins can resend invitations')();
  }
  return sendAgain(req, res, (invitation) => invitation);
};

/**
 * @desc Organization route: re-send a pending invitation of THIS organization. Rights
 * (owner/admin of the org or platform admin) and org scoping are enforced by
 * `requireOrganizationManager` + `invitationInOrganization` before this runs.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with the invitation (no token), 409 when not pending, or the error's own status
 */
const organizationResend = (req, res) => sendAgain(req, res, withoutToken);

/**
 * @desc Shared resend body for the platform and organization routes.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} serialize - shapes the invitation for the response
 * @returns {Promise<void>}
 */
const sendAgain = async (req, res, serialize) => {
  try {
    const invitation = await InvitationService.resend(req.invitation.id, req.user);
    responses.success(res, 'invitation resent')(serialize(invitation));
  } catch (err) {
    // #3966 hardening: InvitationService.resend's mails.sendMail(...) call is
    // unguarded and now propagates (#3966) — a raw transport rejection has no
    // `.status` (unlike the AppErrors thrown deliberately above) and must not
    // leak the raw SMTP/provider error string to the client. Log the real
    // error server-side with context; respond with a stable generic message.
    if (err.status == null) {
      logger.error('[invitations.resend] failed', {
        invitationId: req.invitation?.id,
        message: err?.message,
        stack: err?.stack,
      });
      return responses.error(res, 500, undefined, 'Failed to send the email, please try again.')(err);
    }
    responses.error(res, undefined, undefined, errors.getMessage(err))(err);
  }
};

/**
 * @desc Public: report whether a token is a valid invite (+ prefill email)
 * @param {Object} req - Express request object
 * @param {Object} req.params - Route parameters
 * @param {string} req.params.token - Invitation token to verify
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with { valid, email, organization } (organization = { name } for an org invite, else null) or the error's own status (500 when it has none)
 */
const verify = async (req, res) => {
  try {
    const result = await InvitationService.verify(req.params.token);
    responses.success(res, 'invitation verify')(result);
  } catch (err) {
    responses.error(res, undefined, undefined, errors.getMessage(err))(err);
  }
};

/**
 * @desc Middleware to load an invitation into req.invitation by id param
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @param {string} id - Invitation id from URL param
 * @returns {Promise<void>} Calls next() with invitation on req, or sends 404
 */
const invitationByID = async (req, res, next, id) => {
  try {
    const invitation = await InvitationService.get(id);
    if (!invitation) return responses.error(res, 404, 'Not Found', 'No invitation with that identifier has been found')();
    req.invitation = invitation;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * @desc Organization routes gate: the caller must be an OWNER/ADMIN of the organization
 * loaded from `:organizationId` (ACTIVE membership, via the organizations membership
 * loader) or a platform admin. Independent of `invitations.userFacing`. Deliberately NOT
 * CASL `policy.isAllowed`: on `/api/organizations/...` paths the organizations policy
 * resolves the loaded org as an `Organization` subject (POST = `create Organization`,
 * which any user holds; DELETE = `delete Organization`, which org admins lack).
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const requireOrganizationManager = (req, res, next) => {
  if (!req.organization) return responses.error(res, 404, 'Not Found', 'No Organization with that identifier has been found')();
  if (!canManageMembers(req.user, req.membership)) {
    return responses.error(res, 403, 'Forbidden', 'Insufficient organization role')();
  }
  return next();
};

/**
 * @desc Scope a loaded invitation (`:invitationId`) to the route's organization —
 * another org's invitation, or a platform invite, reads as 404.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const invitationInOrganization = (req, res, next) => {
  const invitationOrgId = req.invitation?.organizationId ? String(req.invitation.organizationId) : null;
  const orgId = String(req.organization?._id || req.organization?.id);
  if (!invitationOrgId || invitationOrgId !== orgId) {
    return responses.error(res, 404, 'Not Found', 'No invitation with that identifier has been found')();
  }
  return next();
};

/**
 * @desc Organization route: list the organization's pending invitations.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with the invitation array (no tokens)
 */
const organizationList = async (req, res) => {
  try {
    const invitations = await InvitationService.listForOrganization(req.organization._id || req.organization.id);
    responses.success(res, 'invitation list')(invitations);
  } catch (err) {
    responses.error(res, undefined, undefined, errors.getMessage(err))(err);
  }
};

/**
 * @desc Organization route: invite an email into the organization with a role. Same
 * role ceiling as adding a member: default member, only an owner (or platform admin)
 * may invite an admin/owner.
 * @param {Object} req - Express request object (`user`, `membership`, `organization` set by the gate)
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with the invitation (no token), 403 above the role ceiling, 409 on a live invite for the email, 422 on the create guards
 */
const organizationCreate = async (req, res) => {
  const role = req.body.role || MEMBERSHIP_ROLES.MEMBER;
  if (!canGrantRole(req.user, req.membership, role)) {
    return responses.error(res, 403, 'Forbidden', 'Only owners can invite with an elevated role')();
  }
  try {
    const invitation = await InvitationService.create(req.body.email, req.user, { organization: req.organization, role });
    responses.success(res, 'invitation created')(withoutToken(invitation));
  } catch (err) {
    responses.error(res, undefined, undefined, errors.getMessage(err))(err);
  }
};

export default {
  create,
  list,
  remove,
  resend,
  verify,
  invitationByID,
  requireOrganizationManager,
  invitationInOrganization,
  organizationList,
  organizationCreate,
  organizationResend,
};
