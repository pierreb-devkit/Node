/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';
import BillingExtraBalanceRepository from '../repositories/billing.extraBalance.repository.js';

/**
 * @desc Standard referral grant (#3842) — credits meter units to the referrer's and/or
 *       referee's organization when an invited signup completes. Mirrors the pack-credit
 *       mechanism exactly: same BillingExtraBalance ledger, kind='topup', `source:'referral'`
 *       marker, optional expiry swept by crons/billing.extrasExpiration.js.
 *
 *       Entirely config-gated (`config.billing.referral` — stack default OFF); downstream
 *       projects flip the config, they never edit billing code.
 *
 *       Idempotency: every grant is keyed `referral:<invitationId>:referrer|referee` —
 *       the repository's atomic `'ledger.refId': { $ne: key }` guard (single
 *       findOneAndUpdate, serialized by MongoDB document-level locking) makes a replayed
 *       event a no-op (applied:false). This is the house ledger-dedup mechanism shared by
 *       creditPack / creditGrant / debit — the ledger is an embedded array, so a unique
 *       index cannot enforce within-document uniqueness; the atomic guard does.
 *
 *       Callers: the `invitation.accepted` listener in billing.init.js (latency) and the
 *       reconcile cron crons/billing.referralReconcile.js (truth — back-fills missed
 *       events; EventEmitter is in-process fire-and-forget).
 */

/**
 * @function referralKeys
 * @description Build the two idempotency keys for an invitation's referral grants.
 * @param {string} invitationId - The accepted invitation id.
 * @returns {{referrer: string, referee: string}}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const referralKeys = (invitationId) => ({
  referrer: `referral:${invitationId}:referrer`,
  referee: `referral:${invitationId}:referee`,
});

/**
 * @function resolveGrantOrganization
 * @description Resolve the organization to credit for a user — referral actors are USERS
 *              but billing is ORGANIZATION-scoped. Prefers the user's `currentOrganization`
 *              (set by org provisioning at signup, before the invite finalizes); falls back
 *              to the user's first ACTIVE membership. Returns null when the user has no
 *              organization yet — e.g. the mailer-configured signup flow defers org
 *              provisioning to email verification, so the listener can fire before the
 *              referee has a workspace. A null here is NOT an error: the grant is skipped
 *              and the reconcile cron back-fills it on a later run, once the org exists.
 *
 *              Dependencies are imported lazily: organizations.membership.repository
 *              resolves its Mongoose model at import time, and a static chain
 *              billing → organizations could recreate the service cycle the
 *              extraBalance repository already avoids dynamically (Opus H4 precedent).
 * @param {string} userId - The user ObjectId (string).
 * @returns {Promise<string|null>} The organization id to credit, or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const resolveGrantOrganization = async (userId) => {
  if (!userId) return null;
  const { default: UserService } = await import('../../users/services/users.service.js');
  const user = await UserService.getBrut({ id: String(userId) });
  if (!user) return null;
  if (user.currentOrganization) {
    return String(user.currentOrganization._id || user.currentOrganization);
  }
  // Fallback: the user's active membership (e.g. currentOrganization unset edge cases).
  const [{ default: MembershipRepository }, { MEMBERSHIP_STATUSES }] = await Promise.all([
    import('../../organizations/repositories/organizations.membership.repository.js'),
    import('../../organizations/lib/constants.js'),
  ]);
  const membership = await MembershipRepository.findOne({ userId: String(userId), status: MEMBERSHIP_STATUSES.ACTIVE });
  if (!membership?.organizationId) return null;
  return String(membership.organizationId._id || membership.organizationId);
};

/**
 * @function grantSide
 * @description Credit one side (referrer or referee) of a referral grant idempotently.
 * @param {Object} params
 * @param {string} params.userId - The user whose organization receives the credit.
 * @param {number} params.units - Units to credit (already validated > 0 by the caller).
 * @param {string} params.key - The idempotency key (`referral:<invitationId>:<side>`).
 * @param {Date|null} params.expiresAt - Optional expiry for the grant entry.
 * @returns {Promise<{applied: boolean, reason?: string, organizationId?: string}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const grantSide = async ({ userId, units, key, expiresAt }) => {
  const organizationId = await resolveGrantOrganization(userId);
  if (!organizationId) {
    // No workspace yet (e.g. email verification pending) — the reconcile cron retries.
    logger.info('[billing.referral] no organization to credit yet — left to the reconcile cron', {
      userId: String(userId),
      key,
    });
    return { applied: false, reason: 'no_organization' };
  }
  const result = await BillingExtraBalanceRepository.creditGrant(organizationId, units, 'referral', {
    refId: key,
    expiresAt,
  });
  if (result.applied) {
    logger.info('[billing.referral] credited', { organizationId, units, key });
    return { applied: true, organizationId };
  }
  // Idempotent replay (duplicate key) — expected on event replays and cron overlap.
  return { applied: false, reason: result.reason ?? 'duplicate_grant', organizationId };
};

/**
 * @function grantForInvitation
 * @description Apply the standard referral grant for one accepted invitation:
 *              - referee grant → the accepted user's organization (`refereeUnits`),
 *              - referrer grant → the inviter's organization (`referrerUnits`),
 *                skipped when `invitedBy` is null (actor-less invite) or when
 *                `invitedBy === acceptedUserId` (cheap self-referral floor — the full
 *                guard is #3833).
 *              No-op (`skipped:'disabled'`) when `config.billing.referral.enabled` is
 *              false; a side with 0 configured units is skipped. Each side is keyed
 *              `referral:<invitationId>:<side>` so replays can never double-credit.
 *              May reject on infrastructure errors — callers own their failure handling
 *              (the listener self-guards, the cron counts errors).
 * @param {Object} payload - The `invitation.accepted` payload (or its cron reconstruction).
 * @param {string} payload.invitationId - The accepted invitation id (idempotency root).
 * @param {string|null} payload.invitedBy - The inviter user id, or null.
 * @param {string} payload.acceptedUserId - The referee (just-created user) id.
 * @returns {Promise<{skipped?: string, referrer?: Object, referee?: Object}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const grantForInvitation = async ({ invitationId, invitedBy, acceptedUserId } = {}) => {
  const cfg = config.billing?.referral;
  if (!cfg?.enabled) return { skipped: 'disabled' };
  if (!invitationId) return { skipped: 'no_invitation_id' };

  const keys = referralKeys(String(invitationId));
  const expiresAt = cfg.expiryDays != null && cfg.expiryDays > 0
    ? new Date(Date.now() + cfg.expiryDays * 24 * 60 * 60 * 1000)
    : null;
  const result = {};

  // Referee side — the accepted user's workspace doubles its welcome.
  if (cfg.refereeUnits > 0 && acceptedUserId) {
    result.referee = await grantSide({ userId: acceptedUserId, units: cfg.refereeUnits, key: keys.referee, expiresAt });
  } else {
    result.referee = { applied: false, reason: acceptedUserId ? 'zero_units' : 'no_accepted_user' };
  }

  // Referrer side — skip actor-less invites and trivial self-referrals (#3833 owns the full guard).
  if (!invitedBy) {
    result.referrer = { applied: false, reason: 'no_inviter' };
  } else if (String(invitedBy) === String(acceptedUserId)) {
    result.referrer = { applied: false, reason: 'self_referral' };
  } else if (cfg.referrerUnits > 0) {
    result.referrer = await grantSide({ userId: invitedBy, units: cfg.referrerUnits, key: keys.referrer, expiresAt });
  } else {
    result.referrer = { applied: false, reason: 'zero_units' };
  }

  return result;
};

export default {
  referralKeys,
  resolveGrantOrganization,
  grantForInvitation,
};
