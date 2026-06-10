/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import InvitationService from '../services/invitations.service.js';

/**
 * @desc Admin: create + email a signup invitation
 * @param {Object} req - Express request object
 * @param {string} req.body.email - Email address to invite
 * @param {Object} req.user - Authenticated admin user
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with created invitation or 422 on error
 */
const create = async (req, res) => {
  try {
    const invitation = await InvitationService.create(req.body.email, req.user);
    responses.success(res, 'invitation created')(invitation);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Admin: list all signup invitations
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with invitation array or 422 on error
 */
const list = async (req, res) => {
  try {
    const invitations = await InvitationService.list();
    responses.success(res, 'invitation list')(invitations);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Admin: revoke an invitation
 * @param {Object} req - Express request object
 * @param {Object} req.invitation - Loaded invitation document (set by invitationByID middleware)
 * @param {string} req.invitation.id - Invitation id
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends HTTP 200 with deleted id or 422 on error
 */
const remove = async (req, res) => {
  try {
    await InvitationService.revoke(req.invitation.id);
    responses.success(res, 'invitation deleted')({ id: req.invitation.id });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
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

export default { create, list, remove, verify, invitationByID };
