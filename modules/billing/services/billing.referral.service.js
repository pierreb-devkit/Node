/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';
import mailer from '../../../lib/helpers/mailer/index.js';
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
 *       Link signups (#4214): with `billing.referral.link` on, a user whose `referredBy`
 *       was set by a personal referral link (and who has NO accepted invitation) earns the
 *       same sides, keyed `referral:link:<refereeUserId>:referee` and
 *       `referral:link:<refereeUserId>:referrer:<referrerUserId>`. An accepted
 *       invitation always wins; `invitations.maxLifetime` caps the link rewards per referrer
 *       (counted by referrer id across all ledgers) and is REQUIRED: without a positive integer cap
 *       no link grant happens (`no_cap`).
 *
 *       Callers: the `invitation.accepted` and `organization.provisioned` listeners in
 *       billing.init.js (latency; the latter also grants link signups) and the reconcile
 *       cron crons/billing.referralReconcile.js (truth — back-fills missed invitation AND
 *       link grants; EventEmitter is in-process fire-and-forget).
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
 * @function describeRecord
 * @description Normalize a referral record into its idempotency root and actors. Two shapes:
 *              an invitation (doc with `_id` or accepted payload with `invitationId`, plus
 *              `invitedBy` / `acceptedUserId`) or a link signup (explicit
 *              `{ kind: 'link', userId, referredBy }`, #4214). Pure — no I/O.
 * @param {Object} record - Invitation doc / accepted payload, or link `{ kind: 'link', userId, referredBy }`.
 * @param {Object} cfg - The `config.billing.referral` block.
 * @returns {{root: string, referrerId: *, refereeId: *, referrerSuffix?: string}|null} null when the record has no id or the link flag is off.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const describeRecord = (record, cfg) => {
  if (record?.kind === 'link') {
    if (!cfg?.link) return null;
    // The referrer id rides in the referrer key so the cap can count per referrer across ledgers.
    return { root: `link:${record.userId}`, referrerId: record.referredBy, refereeId: record.userId, referrerSuffix: `:${record.referredBy}` };
  }
  const invitationId = record?._id ?? record?.invitationId;
  if (!invitationId) return null;
  return { root: String(invitationId), referrerId: record.invitedBy, refereeId: record.acceptedUserId };
};

/**
 * @function expectedGrantKeys
 * @description THE single source of the grant side-rules (#3842, #4214): given an invitation
 *              (doc with `_id` or `invitation.accepted` payload with `invitationId`) or a
 *              link signup (`{ kind: 'link', userId, referredBy }`, only when `cfg.link`) and the referral
 *              config, return the grant sides the record implies as `[{ side, key }]`.
 *              A side with 0 configured units, a referrer-less record, and the cheap
 *              self-referral floor (referrer === referee; the full guard is #3833) produce
 *              NO entry. Pure — no I/O. `grantRecord` (grants) and
 *              crons/billing.referralReconcile.js (candidate diff) derive from it, so a
 *              new guard lands in ONE place and the callers can never drift.
 * @param {Object} record - Invitation doc / accepted payload, or link `{ kind: 'link', userId, referredBy }`.
 * @param {Object} cfg - The `config.billing.referral` block.
 * @returns {Array<{side: 'referrer'|'referee', key: string}>} The implied grant sides.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const expectedGrantKeys = (record, cfg) => {
  if (!cfg?.enabled) return [];
  const described = describeRecord(record, cfg);
  if (!described) return [];
  const { root, referrerId, refereeId, referrerSuffix = '' } = described;
  const keys = referralKeys(root);
  /** @type {Array<{side: 'referrer'|'referee', key: string}>} */
  const expected = [];
  // Referee side — needs configured units and a referee user (legacy rows may have none).
  if (cfg.refereeUnits > 0 && refereeId) expected.push({ side: 'referee', key: keys.referee });
  // Referrer side — skip zero units, referrer-less records, and trivial self-referrals.
  if (cfg.referrerUnits > 0 && referrerId && String(referrerId) !== String(refereeId)) {
    expected.push({ side: 'referrer', key: `${keys.referrer}${referrerSuffix}` });
  }
  return expected;
};

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
  // Oldest membership wins (createdAt asc) — deterministic + auditable when a user has several.
  const membership = await MembershipRepository.findOne(
    { userId: String(userId), status: MEMBERSHIP_STATUSES.ACTIVE },
    { sort: { createdAt: 1 } },
  );
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
 * @function notifyReferrer
 * @description Best-effort email to the referrer once their referral reward is
 *              CREDITED (#3945) — today the grant is a silent ledger credit; this closes
 *              that gap by reusing the stack's EXISTING mailer abstraction (mirrors
 *              org-request-approved / org-member-added in
 *              organizations.membership.service.js), not a new notification channel.
 *              Called ONLY when grantSide reports `applied:true` for the referrer side —
 *              the repository's atomic refId dedup guard means that happens exactly ONCE
 *              per invitation, so a reconcile-cron back-fill or a replayed event can never
 *              double-notify. Self-guarded: a mailer/lookup failure is logged and never
 *              propagates — the grant itself already landed and must not be affected.
 * @param {string} userId - The referrer's user id.
 * @param {number} units - Units credited to the referrer (config-driven).
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const notifyReferrer = async (userId, units) => {
  try {
    if (!mailer.isConfigured()) return;
    const { default: UserService } = await import('../../users/services/users.service.js');
    const user = await UserService.getBrut({ id: String(userId) });
    if (!user?.email) return;
    await mailer.sendMail({
      to: user.email,
      subject: `You earned a referral reward — ${mailer.getBrand().name}`,
      template: 'referral-reward-earned',
      params: {
        displayName: [user.firstName, user.lastName].filter(Boolean).join(' '),
        units,
      },
    });
  } catch (err) {
    logger.warn('[billing.referral] referrer notification failed (non-fatal)', {
      userId: String(userId),
      message: err?.message,
    });
  }
};

/**
 * @function grantRecord
 * @description Apply the grant sides one referral record implies (invitation or link):
 *              - referee grant → the referee's organization (`refereeUnits`),
 *              - referrer grant → the referrer's organization (`referrerUnits`), skipped
 *                when there is no referrer or on the self-referral floor.
 *              WHICH sides to grant is derived from `expectedGrantKeys` (the single rule
 *              source shared with the reconcile cron) — the branches below only label WHY
 *              an absent side was skipped (observability). A freshly APPLIED referrer grant
 *              also triggers a best-effort referrer email (#3945, notifyReferrer) — never on
 *              a duplicate/idempotent replay. May reject on infrastructure errors — callers
 *              own their failure handling (listener self-guards, cron counts errors).
 * @param {Object} record - Record accepted by `expectedGrantKeys`.
 * @param {string|null} referrerId - The referrer user id, or null.
 * @param {string|null} refereeId - The referee user id, or null.
 * @param {Object} cfg - The `config.billing.referral` block (enabled).
 * @returns {Promise<{referrer: Object, referee: Object}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const grantRecord = async (record, referrerId, refereeId, cfg) => {
  const isLink = record?.kind === 'link';
  const expected = new Map(expectedGrantKeys(record, cfg).map(({ side, key }) => [side, key]));
  if (cfg.expiryDays !== null && cfg.expiryDays !== undefined && cfg.expiryDays <= 0) {
    throw new Error('billing.referral.expiryDays must be > 0 or null (use null for no expiry)');
  }
  const expiresAt = cfg.expiryDays != null
    ? new Date(Date.now() + cfg.expiryDays * 24 * 60 * 60 * 1000)
    : null;
  const result = {};
  // A key already credited in ANY ledger is never granted again: `creditGrant` only dedups
  // within the target organization, so an org switch between two attempts would otherwise
  // credit the same key twice (once per organization).
  const landed = new Set(await BillingExtraBalanceRepository.findExistingRefIds([...expected.values()]));
  const grantOnce = (params) => (landed.has(params.key)
    ? { applied: false, reason: 'duplicate_grant' }
    : grantSide(params));

  // Referee side — the referred user's workspace doubles its welcome.
  if (expected.has('referee')) {
    result.referee = await grantOnce({ userId: refereeId, units: cfg.refereeUnits, key: expected.get('referee'), expiresAt });
  } else {
    result.referee = { applied: false, reason: refereeId ? 'zero_units' : (isLink ? 'no_referee' : 'no_accepted_user') };
  }

  // Referrer side — skip referrer-less records and trivial self-referrals (#3833 owns the full guard).
  if (expected.has('referrer')) {
    result.referrer = await grantOnce({ userId: referrerId, units: cfg.referrerUnits, key: expected.get('referrer'), expiresAt });
    // #3945: notify ONLY on a freshly applied grant — never on an idempotent replay
    // (grantSide's atomic dedup guard means `applied:true` fires exactly once).
    if (result.referrer.applied) {
      await notifyReferrer(referrerId, cfg.referrerUnits);
    }
  } else if (!referrerId) {
    result.referrer = { applied: false, reason: isLink ? 'no_referrer' : 'no_inviter' };
  } else if (String(referrerId) === String(refereeId)) {
    result.referrer = { applied: false, reason: 'self_referral' };
  } else {
    result.referrer = { applied: false, reason: 'zero_units' };
  }

  return result;
};

/**
 * @function grantForInvitation
 * @description Apply the standard referral grant for one accepted invitation (see
 *              `grantRecord`). No-op (`skipped:'disabled'`) when
 *              `config.billing.referral.enabled` is false. Each side is keyed
 *              `referral:<invitationId>:<side>` so replays can never double-credit.
 * @param {Object} [payload] - The `invitation.accepted` payload (or its cron reconstruction).
 * @param {string} [payload.invitationId] - The accepted invitation id (idempotency root); skipped (`no_invitation_id`) when missing.
 * @param {string|null} [payload.invitedBy] - The inviter user id, or null.
 * @param {string|null} [payload.acceptedUserId] - The referee (just-created user) id, or null for legacy/cron rows.
 * @returns {Promise<{skipped?: string, referrer?: Object, referee?: Object}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const grantForInvitation = async ({ invitationId, invitedBy, acceptedUserId } = {}) => {
  const cfg = config.billing?.referral;
  if (!cfg?.enabled) return { skipped: 'disabled' };
  if (!invitationId) return { skipped: 'no_invitation_id' };
  // No guard against a link grant already made for acceptedUserId: invitation.accepted only
  // fires from signup finalize for a just-created account (invitations.service accept via
  // auth), and invitations.create rejects (422) an email that already has a user.
  return grantRecord({ invitationId, invitedBy, acceptedUserId }, invitedBy, acceptedUserId, cfg);
};

/**
 * @function getLinkCap
 * @description The per-referrer cap for link rewards (#4214): `invitations.maxLifetime`
 *              when it is a positive integer, else null. Link rewards fail closed without
 *              a cap (a null / undefined / 0 / non-integer value means NO link grant).
 * @returns {number|null} The cap, or null when none is configured.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getLinkCap = () => {
  const cap = config.invitations?.maxLifetime;
  return Number.isInteger(cap) && cap > 0 ? cap : null;
};

/**
 * @function linkBudget
 * @description How many more link rewards a referrer can earn: the cap minus the link
 *              referrer grants already made for THIS referrer across all ledgers (the
 *              referrer id is in the key), so neither deleting referred users nor creating
 *              or switching to another organization resets it. Infinity when `referrerUnits` is 0 — no referrer
 *              entry is ever written, so the cap cannot bind (referee-only rewards carry the
 *              same exposure as the signup grant). Not atomic: concurrent grants for one referrer can each pass the check.
 * @param {string} referredBy - The referrer user id.
 * @param {number} cap - The positive-integer cap (see getLinkCap).
 * @returns {Promise<{remaining?: number, skipped?: string}>} `skipped:'referrer_no_organization'`
 *          when the referrer has no workspace yet (fail closed; the cron retries).
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const linkBudget = async (referredBy, cap) => {
  if (!(config.billing?.referral?.referrerUnits > 0)) return { remaining: Infinity };
  const organizationId = await resolveGrantOrganization(referredBy);
  if (!organizationId) return { skipped: 'referrer_no_organization' };
  const used = await BillingExtraBalanceRepository.countLinkReferrerGrants(String(referredBy));
  return { remaining: cap - used };
};

/**
 * @function grantForLink
 * @description Apply the referral grant for a signup made through a personal referral link
 *              (#4214): same sides as an invitation, keyed
 *              `referral:link:<userId>:referee` / `referral:link:<userId>:referrer:<referrerId>`. Skipped (labelled) when the link
 *              reward is off (`disabled`), when `invitations.maxLifetime` is not a positive
 *              integer (`no_cap`, logged at warn), when the user has an accepted invitation
 *              (the invite always wins, `invited`), when the referrer has no workspace yet
 *              (`referrer_no_organization`) or when the referrer's cap is reached
 *              (`cap_reached`; a user whose own referrer grant already landed is never
 *              locked out of finishing their referee side). May reject on infrastructure
 *              errors — callers own their failure handling.
 * @param {Object} [payload]
 * @param {string} [payload.userId] - The referred (just-signed-up) user id; skipped (`no_link`) when missing.
 * @param {string} [payload.referredBy] - The referrer user id; skipped (`no_link`) when missing.
 * @param {Object|null} [payload.invitation] - The caller's already-fetched accepted
 *        invitation for this user (null = looked up, none). Omit to look it up here.
 * @returns {Promise<{skipped?: string, referrer?: Object, referee?: Object}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const grantForLink = async ({ userId, referredBy, invitation } = {}) => {
  const cfg = config.billing?.referral;
  if (!cfg?.enabled || !cfg.link) return { skipped: 'disabled' };
  if (!userId || !referredBy) return { skipped: 'no_link' };
  const cap = getLinkCap();
  if (!cap) {
    logger.warn('[billing.referral] billing.referral.link needs invitations.maxLifetime (a positive integer) — no link grant', { userId: String(userId) });
    return { skipped: 'no_cap' };
  }
  let accepted = invitation;
  if (accepted === undefined) {
    const { default: InvitationRepository } = await import('../../invitations/repositories/invitations.repository.js');
    accepted = await InvitationRepository.findByAcceptedUserId(String(userId));
  }
  if (accepted) return { skipped: 'invited' };
  const budget = await linkBudget(String(referredBy), cap);
  if (budget.skipped) return { skipped: budget.skipped };
  if (budget.remaining <= 0) {
    const ownKey = expectedGrantKeys({ kind: 'link', userId, referredBy }, cfg).find(({ side }) => side === 'referrer')?.key;
    if (!ownKey || (await BillingExtraBalanceRepository.findExistingRefIds([ownKey])).length === 0) return { skipped: 'cap_reached' };
  }
  return grantRecord({ kind: 'link', userId, referredBy }, referredBy, userId, cfg);
};

export default {
  referralKeys,
  expectedGrantKeys,
  resolveGrantOrganization,
  grantForInvitation,
  grantForLink,
  getLinkCap,
  linkBudget,
};
