/**
 * Module dependencies
 */
import crypto from 'crypto';

import UserService from '../../users/services/users.service.js';
import Eligibility from './auth.eligibility.js';
import { computeSignupCapacity } from './auth.signupCapacity.js';
import config from '../../../config/index.js';
import mails from '../../../lib/helpers/mailer/index.js';
import AppError from '../../../lib/helpers/AppError.js';
import AuthOrganizationService from '../../organizations/services/organizations.service.js';
import AnalyticsService from '../../../lib/services/analytics.js';
import logger from '../../../lib/services/logger.js';
import getBaseUrl from '../../../lib/helpers/getBaseUrl.js';

/**
 * @desc Check whether the mailer is configured with a real sender address.
 * Delegates to the centralized helper in lib/helpers/mailer. Controller-local
 * helper (not a mailer-lib export) — auth.controller re-imports this for its
 * own `getConfig` and `resendVerification` endpoints, which call it directly.
 * @returns {boolean} true when SMTP mail sending is available
 */
export const isMailerConfigured = () => mails.isConfigured();

/**
 * @desc Send a verification email to the user with a signed token link.
 * Controller-local helper (not a mailer-lib export) — auth.controller
 * re-imports this for its own `resendVerification` endpoint, which calls it
 * directly.
 * @param {Object} user - User object (must have email, firstName, lastName)
 * @param {string} verificationToken - The email verification token
 * @returns {Promise<Object>} nodemailer send result
 */
export const sendVerificationEmail = async (user, verificationToken) => {
  const mail = await mails.sendMail({
    template: 'verify-email',
    to: user.email,
    subject: 'Verify your email address',
    params: {
      displayName: [user.firstName, user.lastName].filter(Boolean).join(' '),
      url: `${getBaseUrl()}/verify-email?token=${verificationToken}`,
      appName: config.app.title,
      appContact: config.app.contact,
    },
  });
  return mail;
};

/**
 * @desc Flatten a persisted `attribution` subdocument into PostHog-style
 * snake_case event properties. Only present keys are included (absent
 * attribution, or an absent individual field, contributes nothing) — mirrors
 * the "only keys that are present" contract for the `user_signed_up` event.
 * @param {Object|undefined} attribution - persisted attribution subdocument
 * @returns {Object} flattened snake_case properties, possibly empty
 */
const attributionEventProperties = (attribution) => {
  if (!attribution || typeof attribution !== 'object') return {};
  const map = {
    referrer: 'referrer',
    landingPath: 'landing_path',
    utmSource: 'utm_source',
    utmMedium: 'utm_medium',
    utmCampaign: 'utm_campaign',
    utmTerm: 'utm_term',
    utmContent: 'utm_content',
  };
  const properties = {};
  for (const [camelKey, snakeKey] of Object.entries(map)) {
    if (attribution[camelKey] !== undefined) properties[snakeKey] = attribution[camelKey];
  }
  return properties;
};

/**
 * @desc Run the full account-signup flow: capacity + invite-eligibility
 * gating, mass-assignment scrubbing, user creation, email verification,
 * organization provisioning, analytics and invite finalize/release.
 *
 * HTTP-agnostic: thrown errors propagate to the caller (auth.controller's
 * `signup`) for status mapping. The capacity/eligibility gate rejection is
 * signaled via an AppError carrying `code: 'SIGNUP_DISABLED'` rather than
 * writing a response directly, so the caller can reconstruct the exact
 * original 404 response (status, title, description — no `err` argument)
 * instead of falling through to the generic 422 mapping. Every distinct
 * error status this flow can produce keeps its own status/title/message;
 * none are collapsed into a shared helper.
 * @param {Object} req - Express request object. `req.body` is read verbatim
 *   (email, and every signup field); the whole object is also relayed
 *   opaquely as `ctx.req` to the eligibility registry (an invite checker may
 *   read `req.query`/`req.body` for a presented token — see
 *   modules/invitations/invitations.init.js).
 * @returns {Promise<{user: Object, orgResult: Object}>} the created user
 *   (post-verification, sanitized by UserService.create) and the
 *   organization-provisioning result — together, everything
 *   auth.controller.signup's response block reads.
 */
const signup = async (req) => {
  // Two AND-ed gates: (1) capacity — a hard ceiling on total accounts,
  // invited users included; (2) eligibility — public signup open OR a valid
  // invite token. The eligibility check is supplied by optional modules via the
  // generic registry (auth never imports invitation code). The invitations
  // checker resolves the email-pinned invite, atomically CLAIMS it when required
  // (closed signup) or opted into (open signup + `invitations.userFacing`, #3981;
  // a lost claim race there downgrades to unclaimed instead of blocking signup —
  // see invitations.init.js), and RETURNS `{ invite, claimed, finalize, release }`,
  // which auth relays back here verbatim (opaque result) so this service can
  // canonicalize the account email + finalize/release the invite below.
  // E4: cap is computed by computeSignupCapacity (single source of truth shared
  // with getConfig) — a BLANK cap ('') means UNCAPPED. The old inline Number('')→0
  // hard-rejected everyone while getConfig advertised the deployment as open.
  // remaining<=0 (and cap>0) ⇒ the ceiling is reached. Accepted TOCTOU: cap is
  // checked then the user created non-atomically, so a burst of concurrent signups
  // can overshoot the cap by a few accounts (a small beta overshoot, tolerated).
  const { cap, remaining } = await computeSignupCapacity(config.sign?.cap, UserService.count);
  // Note the `cap > 0` guard: a `cap:0` deployment is NOT `capReached` here. cap:0
  // ({cap:0, remaining:0} per computeSignupCapacity) means "closed to the public",
  // and its rejection rides the `!sign.up && !invite` arm below — invites intentionally
  // bypass a zero cap (computeSignupCapacity short-circuits the count for cap<=0), so an
  // invited signup under cap:0 still passes the gate. capReached is only for a real
  // positive ceiling that filled up (which DOES reject invites — they count in the cap).
  const capReached = cap != null && cap > 0 && remaining <= 0;
  // `signupOpen` tells the checker whether the invite is REQUIRED to open the gate.
  // When public signup is open a token may be PRESENTED but is not required — by
  // default (`invitations.userFacing: false`) the checker resolves WITHOUT claiming
  // (E2), so an open-signup signup never burns / locks a presented token (preserves
  // the P2 `!config.sign.up` gating). With `userFacing: true` the checker DOES claim
  // it (#3981), but open signup's own invariant — a presented token must never be
  // able to fail an otherwise-valid signup — still holds: a lost claim race there
  // downgrades to unclaimed rather than throwing (see invitations.init.js).
  const eligibility = await Eligibility.assertSignupEligible({ email: req.body.email, body: req.body, req, signupOpen: !!config.sign.up });
  // null when no optional module opened the gate (registry empty or no valid invite).
  const invite = eligibility?.invite || null;
  // #3981: whether the invite needs finalize on success / release on failure is
  // decided by `eligibility.claimed` — relayed verbatim from the checker that
  // actually called claim() (invitations.init.js), the single source of truth for
  // "was this atomically claimed". Reading it here rather than re-deriving the
  // closed-signup / userFacing condition a second time from config avoids the two
  // sides ever drifting out of lockstep (a duplicated condition could finalize an
  // invite that was never claimed, or leave a claimed one stuck) — auth stays
  // import-free of invitation code either way, since `claimed` is just a boolean on
  // the opaque relayed result, not a call into invitations.
  const inviteHonored = !!eligibility?.claimed;
  if (capReached || (!config.sign.up && !invite)) {
    // On the closed-signup (or userFacing open-signup) path the eligibility checker
    // CLAIMED the invite (E2) before the cap was found exhausted — release it so a
    // cap bump later does not leave it stuck mid-claim (the lazy sweep would also
    // recover it; this is immediate). Gate the release on `inviteHonored` to avoid a
    // no-op release (+ misleading log) on a presented-but-never-claimed token.
    if (inviteHonored) {
      try {
        await eligibility?.release?.();
      } catch (releaseErr) {
        // Best-effort — the sweep recovers; log it so a burst of "signup blocked"
        // reports is diagnosable (a silently stuck claim looks like a dead invite).
        logger.warn('[signup] invite release failed on capacity gate (left to the sweep)', {
          err: releaseErr?.message,
          stack: releaseErr?.stack,
        });
      }
    }
    // See this function's own doc comment: the caller (auth.controller.signup)
    // matches on `code: 'SIGNUP_DISABLED'` to reconstruct the exact original 404
    // response rather than the generic 422 fallback.
    throw new AppError('Signup error', {
      status: 404,
      code: 'SIGNUP_DISABLED',
      details: { message: 'Registration is currently deactivated' },
    });
  }
  // Force default role on public signup — clients must not self-assign admin.
  // Defense-in-depth against mass assignment: the SignupUser route schema already
  // rejects server-owned keys (.strict()), but UserService.create does NO whitelist
  // filtering, so we ALSO scrub the body here. Force roles + emailVerified, and delete
  // every server-owned field a client could otherwise seed (provider identity, reset /
  // verification tokens, lockout counters). emailVerified:true would self-verify the
  // account and defeat the OAuth-annexation guard (linkProviderByEmail matches on
  // emailVerified:true); a pre-seeded providerData enables identity hijack.
  // `referredBy` is accepted by SignupUser (preventing a .strict() 422 on invite paths
  // that may send it) but ALWAYS deleted here — the server sets it via the invite
  // finalize seam so a client can never self-assign a referrer.
  const safeBody = { ...req.body, roles: ['user'], emailVerified: false };
  for (const serverOwned of [
    'providerData',
    'additionalProvidersData',
    'resetPasswordToken',
    'resetPasswordExpires',
    'emailVerificationToken',
    'emailVerificationExpires',
    'failedLoginAttempts',
    'lockUntil',
    'lastLoginAt',
    'currentOrganization',
    'referredBy',
  ]) delete safeBody[serverOwned];
  // First-touch attribution (#4002/#4003) is a legitimate client-provided field
  // (unlike the server-owned list above), but the feature is inert unless the
  // PostHog client actually initialized — nothing would ever read it back, so
  // strip it before create rather than persist dead data. Gate on
  // AnalyticsService.isConfigured() (client !== null) rather than
  // config.analytics.posthog.enabled directly: `enabled:true` with no `key` set
  // never initializes the client (see lib/services/analytics.js#init), so the
  // config flag alone would silently persist attribution nobody ever reads.
  // When configured, attribution flows into UserService.create untouched
  // (already validated + trimmed + length-capped by SignupUser's `.strict()`
  // Attribution shape) and is flattened onto the `user_signed_up` capture event
  // below.
  if (!AnalyticsService.isConfigured()) delete safeBody.attribution;
  // Invite-gated signup: canonicalize the account email to the invite's pinned
  // (lowercased) email. Enforces the pin exactly AND makes the case-insensitive
  // unique-email index (email_ci_unique, collation strength-2) a reliable single-use backstop — concurrent case-variant
  // signups on the same invite collide on the index instead of creating two accounts.
  if (invite) safeBody.email = invite.email;
  // E2: the invite was atomically CLAIMED (consumingAt stamped) before we got here,
  // so a throw FROM create itself must release the claim too — otherwise the invite
  // stays locked until the 15-min sweep. The most realistic throw is an E11000 from
  // the case-insensitive unique-email index (email_ci_unique) when two case-variant signups race the same
  // invited email (validation/transient errors land here as well). Mirror the three
  // release sites below + the same `inviteHonored` gating (only a claimed invite —
  // closed signup, or userFacing open signup — needs releasing). Best-effort: a
  // release failure must not mask the create error.
  let user;
  try {
    user = await UserService.create(safeBody);
  } catch (createErr) {
    if (inviteHonored) { try { await eligibility?.release?.(); } catch (_releaseErr) { /* best-effort */ } }
    throw createErr;
  }

  // Handle email verification — rollback user on failure to avoid orphaned accounts
  try {
    if (isMailerConfigured()) {
      // Generate verification token and persist it
      const verificationToken = crypto.randomBytes(20).toString('hex');
      const brutUser = await UserService.getBrut({ id: user.id });
      await UserService.update(brutUser, {
        emailVerificationToken: verificationToken,
        emailVerificationExpires: Date.now() + 24 * 3600000, // 24 hours
      }, 'recover');
      // Send verification email (best-effort, do not block signup)
      sendVerificationEmail(user, verificationToken).catch((err) => logger.warn('auth.signup: verification email failed', { message: err?.message, stack: err?.stack }));
    } else if (!invite) {
      // No mailer configured — auto-verify so dev/test are not blocked.
      // E6: do NOT auto-verify an INVITE-created account even with the mailer off.
      // The token proves the INVITER knew the address, not that the SIGNER controls
      // it — an invited account must follow the normal verification path (it just
      // won't receive the email when the mailer is off, same as any account).
      const brutUser = await UserService.getBrut({ id: user.id });
      await UserService.update(brutUser, { emailVerified: true }, 'recover');
      user.emailVerified = true;
    }
  } catch (verifyErr) {
    try { await UserService.remove(user); } catch (_cleanupErr) { /* best-effort */ }
    // E2: a claimed invite must be released on a pre-response failure so the token
    // is reusable (it was only claimed, never finalized). Gate the release on
    // `inviteHonored` — only a claimed invite (closed signup, or userFacing open
    // signup) needs releasing.
    if (inviteHonored) { try { await eligibility?.release?.(); } catch (_releaseErr) { /* best-effort */ } }
    throw verifyErr;
  }

  // Handle organization provisioning based on config
  // If org creation fails, rollback the just-created user
  let orgResult;
  try {
    orgResult = await AuthOrganizationService.handleSignupOrganization(user);
  } catch (orgErr) {
    // Manual rollback: delete the user we just created
    try {
      await UserService.remove(user);
    } catch (_cleanupErr) {
      // Best-effort cleanup; log but don't mask original error
    }
    // E2: release the claimed invite on org-provisioning failure so it can retry
    // (gate on `inviteHonored` — only a claimed invite needs releasing).
    if (inviteHonored) { try { await eligibility?.release?.(); } catch (_releaseErr) { /* best-effort */ } }
    throw orgErr;
  }

  // Analytics — fire-and-forget, never break signup flow
  try {
    AnalyticsService.identify(String(user.id), {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      provider: user.provider,
    });
    AnalyticsService.capture({
      distinctId: String(user.id),
      event: 'user_signed_up',
      properties: {
        email: user.email,
        plan: user.plan,
        createdAt: user.createdAt,
        // #3945: carry invite/referral attribution on the signup event so the
        // referral funnel is measurable. `invite` is the resolved (opaque) result
        // from the eligibility registry — already in scope, no invitations import.
        invited: Boolean(invite),
        invitationId: invite ? String(invite.id) : null,
        invitedBy: invite?.invitedBy ? String(invite.invitedBy) : null,
        // #4002/#4003: first-touch attribution, flattened PostHog-style. Read
        // from `safeBody` (the object actually handed to UserService.create),
        // NOT the sanitized `user` response — `attribution` is deliberately
        // absent from `config.whitelists.users.default`, so `UserService.create`'s
        // `removeSensitive()` return would always strip it regardless of whether
        // it was actually persisted. Empty when analytics was disabled at create
        // time (stripped from safeBody above) or when none was submitted.
        ...attributionEventProperties(safeBody.attribution),
      },
    });
  } catch (_) { /* analytics must not break auth */ }

  // E2 single-use: FINALIZE only when the invite was actually CLAIMED — closed
  // signup (the invite was required), or open signup with `invitations.userFacing`
  // on (#3981: a presented token still converts even though it wasn't required —
  // closes the open-signup hole documented in the invitations README). Otherwise a
  // token can be presented but is not required, and the checker never claimed it,
  // so there is nothing to finalize. finalize burns single-use (usedAt +
  // status:'accepted') and records the user; it runs through the closure returned
  // by the eligibility checker (invitations module owns it; auth never imports
  // invitation code). This is the last pre-response step, and every earlier failure
  // path (create-throw, verify-failure, org-failure) already released the claim
  // under the same `inviteHonored` condition, so reaching finalize means the claim
  // is still ours to burn. finalize itself is best-effort (see catch below).
  if (inviteHonored) {
    try {
      await eligibility?.finalize?.(user._id || user.id);
    } catch (finalizeErr) {
      // Best-effort: the account exists and the response is about to succeed —
      // a finalize DB hiccup must not convert a created account into a 422.
      // The claim stays stamped and the 15-min lazy sweep releases it; the
      // invite is reconcilable from its pending state + the account's email.
      logger.warn('[signup] invite finalize failed post-create (left to the sweep)', {
        userId: String(user._id || user.id),
        err: finalizeErr?.message,
        stack: finalizeErr?.stack,
      });
    }
  }

  return { user, orgResult };
};

export default { signup, isMailerConfigured, sendVerificationEmail };
