/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import logger from '../../../lib/services/logger.js';
import InvitationService from '../services/invitations.service.js';

/**
 * @desc Admin: create + email a signup invitation
 * @param {Object} req - Express request object
 * @param {string} req.body.email - Email address to invite
 * @param {Object} req.user - Authenticated admin user
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with created invitation, 409 on duplicate pending, or 422 on error
 */
const create = async (req, res) => {
  try {
    const invitation = await InvitationService.create(req.body.email, req.user);
    responses.success(res, 'invitation created')(invitation);
  } catch (err) {
    // Thread ANY service-thrown AppError status (409 duplicate-pending, etc.)
    // rather than flattening everything but 409 to 422 (same style as the
    // billing admin controller). create() does not throw 404 today, but the
    // shared form keeps it consistent with resend().
    const status = err.status ?? 422;
    const title = status === 409 ? 'Conflict' : status === 404 ? 'Not Found' : 'Unprocessable Entity';
    responses.error(res, status, title, errors.getMessage(err))(err);
  }
};

/**
 * @desc List signup invitations — role-keyed by the service (#3833):
 * admins get the platform-global list, any other caller only their own.
 * @param {Object} req - Express request object
 * @param {Object} req.user - Authenticated caller (scoping key)
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with invitation array or 422 on error
 */
const list = async (req, res) => {
  try {
    const invitations = await InvitationService.list(req.user);
    responses.success(res, 'invitation list')(invitations);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Admin: revoke a PENDING invitation (pending-only guard in the repository)
 * @param {Object} req - Express request object
 * @param {Object} req.invitation - Loaded invitation document (set by invitationByID middleware)
 * @param {string} req.invitation.id - Invitation id
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with deleted id, 409 when not pending, or 422 on error
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
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Admin: re-send the invitation email for a pending invitation (existing token)
 * @param {Object} req - Express request object
 * @param {Object} req.invitation - Loaded invitation document (set by invitationByID middleware)
 * @param {string} req.invitation.id - Invitation id
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with the invitation, 409 when not pending, or 422 on error
 */
const resend = async (req, res) => {
  try {
    const invitation = await InvitationService.resend(req.invitation.id);
    responses.success(res, 'invitation resent')(invitation);
  } catch (err) {
    // Thread ANY service-thrown AppError status (409 duplicate-pending, 404
    // unknown id, 422 mailer-not-configured, etc.) rather than flattening
    // everything but 409 to 422 — a 404 must not surface as Unprocessable
    // Entity if a future caller reaches the service without the
    // invitationByID param-loader's 404 guard.
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
      return responses.error(res, 422, 'Unprocessable Entity', 'Failed to send the email, please try again.')(err);
    }
    const status = err.status;
    const title = status === 409 ? 'Conflict' : status === 404 ? 'Not Found' : 'Unprocessable Entity';
    responses.error(res, status, title, errors.getMessage(err))(err);
  }
};

/**
 * @desc Public: report whether a token is a valid invite (+ prefill email)
 * @param {Object} req - Express request object
 * @param {string} req.params.token - Invitation token to verify
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with { valid, email } or 422 on error
 */
const verify = async (req, res) => {
  try {
    const invite = await InvitationService.findValid(req.params.token);
    responses.success(res, 'invitation verify')({ valid: !!invite, email: invite ? invite.email : null });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
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

export default { create, list, remove, resend, verify, invitationByID };
