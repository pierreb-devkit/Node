/**
 * Module dependencies
 */
import crypto from 'crypto';

import InvitationRepository from '../repositories/auth.invitation.repository.js';
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
  const days = config.sign?.inviteExpiresInDays || 14;
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
      .catch((err) => logger.warn('auth.invitation: email failed', { message: err?.message }));
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

export default { create, findValid, findValidByEmail, consume, list, get, revoke };
