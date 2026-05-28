/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import InvitationService from '../services/auth.invitation.service.js';

/** @function create — Admin: create + email a signup invitation. */
const create = async (req, res) => {
  try {
    const invitation = await InvitationService.create(req.body.email, req.user);
    responses.success(res, 'invitation created')(invitation);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/** @function list — Admin: list all signup invitations. */
const list = async (req, res) => {
  try {
    const invitations = await InvitationService.list();
    responses.success(res, 'invitation list')(invitations);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/** @function remove — Admin: revoke an invitation. */
const remove = async (req, res) => {
  try {
    await InvitationService.revoke(req.invitation.id);
    responses.success(res, 'invitation deleted')({ id: req.invitation.id });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/** @function verify — Public: report whether a token is a valid invite (+ email). */
const verify = async (req, res) => {
  try {
    const invite = await InvitationService.findValid(req.params.token);
    responses.success(res, 'invitation verify')({ valid: !!invite, email: invite ? invite.email : null });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/** @function invitationByID — Middleware to load an invitation into req.invitation. */
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
