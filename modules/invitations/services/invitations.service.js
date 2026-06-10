/**
 * Module dependencies
 */
import crypto from 'crypto';

import InvitationRepository from '../repositories/invitations.repository.js';
import { DEFAULT_INVITE_EXPIRES_IN_DAYS, STALE_CLAIM_MINUTES } from '../lib/constants.js';
import UserService from '../../users/services/users.service.js';
import config from '../../../config/index.js';
import mails from '../../../lib/helpers/mailer/index.js';
import getBaseUrl from '../../../lib/helpers/getBaseUrl.js';
import logger from '../../../lib/services/logger.js';
import AppError from '../../../lib/helpers/AppError.js';

/**
 * @desc Create an invitation for an email, generate a single-use token, persist,
 * and (best-effort) email the signup link. Token/expiry are server-controlled.
 *
 * E9: rejects (422) when a user with this email already exists — an existing user
 * should be added to the org directly, not re-invited through the signup gate.
 * @param {String} email - invitee email (any case)
 * @param {Object} invitedBy - the admin user creating the invite
 * @returns {Promise<Object>} created invitation
 * @throws {AppError} 422 when a user already exists for this email
 */
const create = async (email, invitedBy) => {
  const normalizedEmail = String(email).toLowerCase().trim();
  // E9: an already-registered email must not be invited — they are already a user.
  const existing = await UserService.findByEmail(normalizedEmail);
  if (existing) {
    throw new AppError('user already exists — this email is already registered', {
      status: 422,
      code: 'VALIDATION_ERROR',
      details: { message: 'A user with this email already exists.' },
    });
  }
  const token = crypto.randomBytes(20).toString('hex');
  const days = config.sign?.inviteExpiresInDays || DEFAULT_INVITE_EXPIRES_IN_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 3600000);
  const invitation = await InvitationRepository.create({
    email: normalizedEmail,
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
 * @desc E2 — lazily release stale claims (consumingAt older than STALE_CLAIM_MINUTES,
 * never finalized). Called at boot and before any validity read so a crash between
 * claim and finalize cannot permanently burn an invite. Best-effort: a sweep error
 * is logged, never thrown (it must not break a signup/read).
 * @returns {Promise<void>}
 */
const sweepStaleClaims = async () => {
  try {
    const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60 * 1000);
    await InvitationRepository.releaseStaleClaims(cutoff);
  } catch (err) {
    logger.warn('invitations: stale-claim sweep failed', { message: err?.message });
  }
};

/**
 * @desc Predicate — is this invitation document currently valid (gate-opening)?
 * A valid invite is `pending`, unconsumed, unexpired, and NOT mid-claim
 * (consumingAt null unless already accepted). Shared by token + email resolution.
 * @param {Object|null} invite
 * @returns {Boolean}
 */
const isUsable = (invite) => {
  if (!invite) return false;
  if (invite.status && invite.status !== 'pending') return false; // E8: revoked/accepted never re-open
  if (invite.usedAt) return false;
  // E2: a claimed-but-unfinalized invite must NOT read as valid (else the OAuth
  // email-resolved path or a concurrent token path could re-accept it → bypass).
  if (invite.consumingAt && !invite.acceptedAt) return false;
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) return false;
  return true;
};

/**
 * @desc Resolve a valid (pending, unused, unexpired, not in-flight) invitation by
 * token. When `email` is supplied, the invite's pinned email must match
 * (case-insensitive). Lazily sweeps stale claims first so a crashed prior signup
 * cannot leave the invite permanently unusable (E2 recovery).
 * @param {String} token
 * @param {String} [email]
 * @returns {Promise<Object|null>}
 */
const findValid = async (token, email) => {
  if (!token) return null;
  await sweepStaleClaims();
  const invite = await InvitationRepository.findByToken(token);
  if (!isUsable(invite)) return null;
  if (email && invite.email && invite.email.toLowerCase() !== String(email).toLowerCase()) return null;
  return invite;
};

/**
 * @desc E2 — resolve a valid pending invite by email (no token), applying the SAME
 * validity rules as findValid (incl. the consumingAt exclusion). Used by the OAuth
 * path, which has no token to claim. A claimed-but-unfinalized invite is invisible
 * here too — the bypass guard. Lazily sweeps stale claims first.
 * @param {String} email - the (provider-verified) email
 * @returns {Promise<Object|null>} the valid pending invite for this email, or null
 */
const findValidByEmail = async (email) => {
  if (!email) return null;
  await sweepStaleClaims();
  // The repository query already filters status:'pending' + consumingAt:null +
  // usedAt:null + unexpired, but re-check via isUsable for a single source of truth.
  const invite = await InvitationRepository.findByEmail(String(email).toLowerCase().trim());
  return isUsable(invite) ? invite : null;
};

/**
 * @desc Signup eligibility resolver — reproduces the exact local-signup invite gate.
 * Resolves a valid invite for `token` (email-pinned) and enforces the "an invite
 * bound to an email must not be honored when the signup supplies no email to match"
 * rule (E5). Returns the resolved invite or null when no invite opens the gate.
 *
 * NOTE: this RESOLVES; it does NOT claim or throw. The eligibility hook composes the
 * throw decision (closed signup AND no invite ⇒ block) in auth; the atomic CLAIM
 * (the replay guard) happens in `claim()` once auth decides to proceed.
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
  // verify endpoint reuses it, so enforce the pin here (E5 — owned by this module).
  if (invite && invite.email && !email) return null;
  return invite;
};

/**
 * @desc OAuth signup eligibility resolver — resolves a valid pending invite by the
 * provider-verified email (no token rides the OAuth redirect). Delegates to
 * findValidByEmail so it inherits the consumingAt exclusion (E2 bypass guard); the
 * OAuth gate decision (whether to honor it) stays in auth.controller.
 * @param {Object} args
 * @param {String} [args.email] - the provider-verified email
 * @returns {Promise<Object|null>} the pending invite for this email, or null
 */
const assertInvitedByEmail = async ({ email } = {}) => findValidByEmail(email);

/**
 * @desc E2 — atomically CLAIM the invite that opened the gate, BEFORE the user is
 * created. Stamps `consumingAt` so a replay / concurrent accept / email-resolved
 * path sees it as in-flight (invalid). Throws 422 when the invite is no longer
 * claimable (already claimed/used/revoked) — the replay / double-accept guard.
 * @param {String} token - the token whose invite was resolved by assertInvited
 * @returns {Promise<Object>} the claimed invite document
 * @throws {AppError} 422 when the invite cannot be claimed
 */
const claim = async (token) => {
  const claimed = await InvitationRepository.claim(token);
  if (!claimed) {
    throw new AppError('invitation is no longer valid', {
      status: 422,
      code: 'VALIDATION_ERROR',
      details: { message: 'This invitation has already been used or is no longer valid.' },
    });
  }
  return claimed;
};

/**
 * @desc E2 — finalize a claimed invite on FULL signup success: mark accepted, record
 * the user, burn single-use. Checks the repository return (a null means the invite
 * was not in a finalizable state — surfaced as a warning, never silently ignored).
 * @param {String} id - the claimed invite id
 * @param {String} userId - the just-created user's id
 * @returns {Promise<Object|null>} the finalized invite, or null
 */
const finalize = async (id, userId) => {
  const result = await InvitationRepository.finalize(id, userId);
  if (!result) {
    logger.warn('invitations: finalize found no in-flight claim to accept', { id: String(id) });
  }
  return result;
};

/**
 * @desc E2 — release a claimed-but-unfinalized invite (on any pre-response signup
 * failure) so it can be retried. Checks the repository return.
 * @param {String} id - the claimed invite id
 * @returns {Promise<Object|null>} the released invite, or null
 */
const release = async (id) => {
  const result = await InvitationRepository.release(id);
  if (!result) {
    logger.warn('invitations: release found no claim to clear', { id: String(id) });
  }
  return result;
};

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
 * @desc E8 — soft-delete (revoke) an invitation by id (status:'revoked' + revokedAt,
 * NOT a hard delete), preserving invitedBy/acceptedUserId for the referral phase.
 * @param {String} id
 * @returns {Promise<Object|null>} the revoked invitation
 */
const revoke = (id) => InvitationRepository.revoke(id);

export default {
  create,
  findValid,
  findValidByEmail,
  assertInvited,
  assertInvitedByEmail,
  claim,
  finalize,
  release,
  sweepStaleClaims,
  list,
  get,
  revoke,
};
