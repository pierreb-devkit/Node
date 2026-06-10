/**
 * Module dependencies
 */
import crypto from 'crypto';

import InvitationRepository from '../repositories/invitations.repository.js';
import { DEFAULT_INVITE_EXPIRES_IN_DAYS } from '../lib/constants.js';
import config from '../../../config/index.js';
import mails from '../../../lib/helpers/mailer/index.js';
import getBaseUrl from '../../../lib/helpers/getBaseUrl.js';
import logger from '../../../lib/services/logger.js';

/**
 * @desc Create an invitation for an email, generate a single-use token, persist,
 * and (best-effort) email the signup link. Token/expiry are server-controlled.
 * @param {String} email - invitee email (any case)
 * @param {Object} invitedBy - the admin user creating the invite
 * @returns {Promise<Object>} created invitation
 */
const create = async (email, invitedBy) => {
  const token = crypto.randomBytes(20).toString('hex');
  const days = config.sign?.inviteExpiresInDays || DEFAULT_INVITE_EXPIRES_IN_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 3600000);
  const invitation = await InvitationRepository.create({
    email: String(email).toLowerCase().trim(),
    token,
    expiresAt,
    invitedBy: invitedBy?.id || invitedBy?._id || null,
  });
  if (mails.isConfigured()) {
    mails
      .sendMail({
        template: 'signup-invite',
        to: invitation.email,
        subject: `You're invited to ${config.app.title}`,
        params: {
          url: `${getBaseUrl()}/signup?inviteToken=${token}`,
          appName: config.app.title,
          appContact: config.app.contact,
        },
      })
      .catch((err) => logger.warn('invitations: email failed', { message: err?.message }));
  }
  return invitation;
};

/**
 * @desc Resolve a valid (unused, unexpired) invitation by token. When `email`
 * is supplied, the invite's pinned email must match (case-insensitive).
 * @param {String} token
 * @param {String} [email]
 * @returns {Promise<Object|null>}
 */
const findValid = async (token, email) => {
  if (!token) return null;
  const invite = await InvitationRepository.findByToken(token);
  if (!invite || invite.usedAt) return null;
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) return null;
  if (email && invite.email && invite.email.toLowerCase() !== String(email).toLowerCase()) return null;
  return invite;
};

/**
 * @desc Resolve a valid invitation by email (OAuth path, where no token rides
 * the redirect). Matches the provider's verified email against a pending invite.
 * @param {String} email
 * @returns {Promise<Object|null>}
 */
const findValidByEmail = async (email) => {
  if (!email) return null;
  return InvitationRepository.findByEmail(String(email).toLowerCase().trim());
};

/**
 * @desc Signup eligibility resolver — reproduces the exact local-signup invite gate.
 * Resolves a valid invite for `token` (email-pinned) and enforces the controller's
 * "an invite bound to an email must not be honored when the signup supplies no email
 * to match" rule. Returns the resolved invite (so the caller can canonicalize the
 * account email + consume it) or null when no invite opens the gate.
 *
 * NOTE: this resolves; it does NOT throw. The eligibility hook composes the throw
 * decision (closed signup AND no invite ⇒ block) in auth — keeping the gate policy
 * (cap + sign.up) owned by auth, and only the invite lookup owned by this module.
 * @param {Object} args
 * @param {String} [args.token] - invite token from the signup request (query/body)
 * @param {String} [args.email] - email supplied on the signup request body
 * @returns {Promise<Object|null>} the valid, email-matched invite, or null
 */
const assertInvited = async ({ token, email } = {}) => {
  if (!token) return null;
  const invite = await findValid(token, email);
  // An invite is bound to its email; never honor it for a signup that supplies no
  // email to match. findValid stays lenient on a falsy email because the public
  // verify endpoint reuses it, so enforce the pin here (mirrors auth.controller).
  if (invite && invite.email && !email) return null;
  return invite;
};

/**
 * @desc OAuth signup eligibility resolver — resolves a pending invite by the
 * provider-verified email (no token rides the OAuth redirect). Thin wrapper over
 * findValidByEmail so the OAuth gate decision stays in auth.controller.
 * @param {Object} args
 * @param {String} [args.email] - the provider-verified email
 * @returns {Promise<Object|null>} the pending invite for this email, or null
 */
const assertInvitedByEmail = async ({ email } = {}) => findValidByEmail(email);

/**
 * @desc Atomically consume (mark used) an invitation. Best-effort single-use.
 * @param {String} id
 * @returns {Promise<Object|null>}
 */
const consume = (id) => InvitationRepository.consume(id);

/**
 * @desc List all invitations (admin)
 * @returns {Promise<Array>}
 */
const list = () => InvitationRepository.list();

/**
 * @desc Get one invitation by id
 * @param {String} id
 * @returns {Promise<Object|null>}
 */
const get = (id) => InvitationRepository.get(id);

/**
 * @desc Revoke (delete) an invitation by id
 * @param {String} id
 * @returns {Promise<Object>}
 */
const revoke = (id) => InvitationRepository.remove(id);

export default { create, findValid, findValidByEmail, assertInvited, assertInvitedByEmail, consume, list, get, revoke };
