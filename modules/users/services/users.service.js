/**
 * Module dependencies
 */
import crypto from 'crypto';
import _ from 'lodash';

import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';
import getBaseUrl from '../../../lib/helpers/getBaseUrl.js';
import getApiBaseUrl from '../../../lib/helpers/getApiBaseUrl.js';
import mailer from '../../../lib/helpers/mailer/index.js';
import passwordHelper from '../../../lib/helpers/password.js';
import UserRepository from '../repositories/users.repository.js';
import MembershipService from '../../organizations/services/organizations.membership.service.js';
import MembershipRepository from '../../organizations/repositories/organizations.membership.repository.js';
import { MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES } from '../../organizations/lib/constants.js';
import { removeSensitive } from '../utils/sanitizeUser.js';
import { createUnsubscribeToken } from '../utils/unsubscribeToken.js';
// `EmailKind` only — NOT `users.schema.js`, which reads `config.whitelists.users.roles`
// at module-evaluation time (see users.emailPreferences.schema.js's doc comment).
import { EmailKind } from '../models/users.emailPreferences.schema.js';

/**
 * @function normalizeEmail
 * @desc Lowercase + trim an email for case-insensitive comparison. MUST stay in sync
 *   with the repository-layer normalization (UserRepository, module-local there) —
 *   duplicated here as a one-liner to keep the layering untouched; if the repository
 *   normalization ever changes (e.g. Unicode fold), update both so the email-change
 *   guard's previous-vs-new comparison cannot drift.
 * @param {string} email - raw email value
 * @returns {string|null} normalized email, or null for a non-string input
 */
const normalizeEmail = (email) => (typeof email === 'string' ? email.toLowerCase().trim() : null);

/**
 * @desc Function to get all users in db
 * @param {String} search
 * @param {Int} page
 * @param {Int} perPage
 * @returns {Promise<Array>} users selected
 */
const list = async (search, page, perPage) => {
  const result = await UserRepository.list(search, page || 0, perPage || 20);
  return result.map((user) => removeSensitive(user));
};

/**
 * @desc Function to ask repository to create a user (define provider, check & hashpassword, save)
 * @param {Object} user
 * @returns {Promise<Object>} created user (sanitized)
 */
const create = async (user) => {
  // Set provider to local
  if (!user.provider) user.provider = 'local';
  // confirming to secure password policies
  if (user.password) {
    // Password-strength validation is enforced at the model layer via its schema refinement/helper.
    // const validPassword = zxcvbn(user.password);
    // if (!validPassword || !validPassword.score || validPassword.score < config.zxcvbn.minimumScore) {
    //   throw new AppError(`${validPassword.feedback.warning}. ${validPassword.feedback.suggestions.join('. ')}`);
    // }
    // When password is provided we need to make sure we are hashing it
    user.password = await passwordHelper.hashPassword(user.password);
  }
  const result = await UserRepository.create(user);
  // Remove sensitive data before return
  return removeSensitive(result);
};

/**
 * @desc Function to ask repository to search users by request
 * @param {Object} input - mongoose query input
 * @returns {Promise<Array>} matching users (sanitized)
 */
const search = async (input) => {
  const result = await UserRepository.search(input);
  return result.map((user) => removeSensitive(user));
};

/**
 * @desc Function to ask repository to get a user by id or email
 * @param {Object} user - object with id or email field
 * @returns {Promise<Object|null>} sanitized user or null
 */
const get = async (user) => {
  const result = await UserRepository.get(user);
  return removeSensitive(result);
};

/**
 * @desc Function to ask repository to get a user by id or email without filter data return (test & intern usage)
 * @param {Object} user - object with id or email field
 * @returns {Promise<Object|null>} full user document or null
 */
const getBrut = async (user) => {
  const result = await UserRepository.get(user);
  return result;
};

/**
 * @desc Function to ask repository to update a user
 * @param {Object} user - original user document
 * @param {Object} body - fields to update
 * @param {string} [option] - update mode: 'admin', 'recover', or undefined for user self-update
 * @returns {Promise<Object>} updated user (sanitized)
 */
const update = async (user, body, option) => {
  const previousEmail = user.email;
  if (!option) user = _.assignIn(user, removeSensitive(body, config.whitelists.users.update));
  else if (option === 'admin') user = _.assignIn(user, removeSensitive(body, config.whitelists.users.updateAdmin));
  else if (option === 'recover') user = _.assignIn(user, removeSensitive(body, config.whitelists.users.recover));

  // #3825 — an email change through the self ('update') or admin ('updateAdmin')
  // whitelists must invalidate the verified state: a stale emailVerified:true on a
  // brand-new address lets linkProviderByEmail ({ email, emailVerified: true })
  // attach an OAuth identity to an address the account never proved it owns. The
  // 'recover' option is exempt — it is the internal writer that SETS verification
  // state (verifyEmail, signup). Mailer-less deployments are exempt too: signup
  // auto-verifies there by design (trust-any-email), and resetting with no way to
  // send a new verification mail would break OAuth linking with no recovery path.
  // The whitelist only filters the BODY, so the service can set these fields itself.
  let verificationToken = null;
  if (option !== 'recover' && mailer.isConfigured()) {
    const normalizedNew = normalizeEmail(user.email);
    const normalizedPrevious = normalizeEmail(previousEmail);
    if (normalizedNew && normalizedNew !== normalizedPrevious) {
      verificationToken = crypto.randomBytes(20).toString('hex');
      user.emailVerified = false;
      user.emailVerificationToken = verificationToken;
      user.emailVerificationExpires = Date.now() + 24 * 3600000; // 24 hours
    }
  }

  const result = await UserRepository.update(user);

  // Fire-and-forget the re-verification mail to the NEW address (same template and
  // params shape as the signup verification mail). Never blocks or fails the update;
  // re-sends are covered by POST /api/auth/resend-verification.
  if (verificationToken) {
    mailer.sendMail({
      template: 'verify-email',
      to: result.email,
      subject: 'Verify your email address',
      params: {
        displayName: [result.firstName, result.lastName].filter(Boolean).join(' '),
        url: `${getBaseUrl()}/verify-email?token=${verificationToken}`,
        appName: config.app.title,
        appContact: config.app.contact,
      },
    }).catch((err) => logger.warn('users.update: email-change verification email failed', { message: err?.message, stack: err?.stack }));
  }

  return removeSensitive(result);
};

/**
 * @desc Atomically consume an email-verification token: verifies the email and clears
 *       the token in one write (see UserRepository.consumeEmailVerificationToken),
 *       instead of a separate read-then-write that lets two concurrent requests for
 *       the same token both pass the read check.
 * @param {String} token - The raw emailVerificationToken from the verification link.
 * @returns {Promise<Object|null>} full ("brut", unsanitized — same convention as
 *   getBrut) user document, or null when the token could not be atomically consumed
 *   (unknown, expired, or already used).
 */
const consumeEmailVerificationToken = (token) => UserRepository.consumeEmailVerificationToken(token);

/**
 * @desc Send a product email (onboarding series / announcement) to one user,
 * respecting their per-kind opt-out (#4162). Mirrors the existing
 * `mailer.sendMail` contract (template/subject/params/from/replyTo) and adds
 * two distinct links on top (epic-audit follow-up on #4160/#4127):
 *
 * - `unsubscribeUrl` — the one-click token POST, `POST /api/users/unsubscribe/:token`.
 *   An API route, not a frontend page, so it's built from `getApiBaseUrl()`
 *   (`config.domain`, the stack's one documented public domain — see
 *   `lib/helpers/config.js`'s `validateDomainIsSet` warning; falls back to
 *   `config.api.*`, the server's own BIND settings, ONLY when `domain` is
 *   empty), never `getBaseUrl()` (`config.cors.origin`, the frontend
 *   origin) — those two can be, and in a real deployment usually are,
 *   different hosts. This is also the `List-Unsubscribe` /
 *   `List-Unsubscribe-Post` header value (RFC 8058), so a mail client can
 *   offer a true one-click unsubscribe with no page and no login.
 * - `emailSettingsUrl` — the human-readable footer link, to the frontend's
 *   account/profile page (`getBaseUrl()` + `config.users.emailSettingsPath`),
 *   where a signed-in user can review every kind, not just toggle the one
 *   this mail happens to carry. `unsubscribeUrl` is kept in `params` too
 *   (backward compat for any template already rendering it directly).
 *
 * Skipped silently (no error, no send) when the user opted out of this kind,
 * or hasn't verified their email — product mail is never pushed at an
 * address the account owner hasn't proven. An unconfigured mailer degrades
 * the same way `mailer.sendMail` already does elsewhere (resolves to null).
 * @param {Object} user - user document (`_id`/`id`, `email`, `emailVerified`,
 *   `emailPreferences`)
 * @param {Object} mail
 * @param {'onboarding'|'news'} mail.kind - must match `EmailKind` (users.emailPreferences.schema.js)
 * @param {string} mail.template - handlebars template key (see mailer/index.js)
 * @param {string} mail.subject
 * @param {Object} [mail.params] - template params; `unsubscribeUrl` and
 *   `emailSettingsUrl` are added on top
 * @param {string} [mail.from]
 * @param {string|string[]} [mail.replyTo]
 * @returns {Promise<Object|null>} the mailer result, or null when skipped or
 *   the mailer isn't configured
 */
const sendProductMail = async (user, { kind, template, subject, params, from, replyTo }) => {
  const parsedKind = EmailKind.parse(kind);
  if (!user?.emailVerified) return null;
  if (user.emailPreferences?.[parsedKind] === false) return null;

  const userId = String(user._id || user.id);
  const unsubscribeUrl = `${getApiBaseUrl()}/users/unsubscribe/${createUnsubscribeToken(userId, parsedKind)}`;
  // Exactly one '/' between the two, regardless of whether a downstream's
  // `config.users.emailSettingsPath` override carries its own leading slash.
  const emailSettingsUrl = `${getBaseUrl()}/${String(config.users.emailSettingsPath).replace(/^\/+/, '')}`;

  return mailer.sendMail({
    template,
    to: user.email,
    subject,
    params: { ...params, unsubscribeUrl, emailSettingsUrl },
    from,
    replyTo,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
};

// Page size for `announce`'s _id-ordered recipient walk (#4162) — see UserRepository.findPage.
const ANNOUNCE_PAGE_SIZE = 200;

/**
 * @desc Walk `UserRepository.findPage` in `_id`-ordered pages, calling
 * `sendProductMail` for every recipient the filter matches (#4162, #4163).
 * Factored out of `announce` so the config-declared email-sequences cron
 * (`modules/users/crons/users.emailSequences.js`) can reuse the exact same
 * paginate → send → catch → count walk instead of drifting a second,
 * near-identical copy of it. NOT part of the default export below — this is
 * an internal seam between this service and that one cron script, not a
 * public `UserService` operation in its own right.
 *
 * Pages, not a server-side cursor, on purpose: the sequential per-recipient
 * sends below can be slow enough between pages to outlive a MongoDB
 * cursor's idle timeout. The opt-out/verified filter is applied per page
 * query — a user who flips their preference mid-run is not re-checked at
 * send time, only the already-fetched snapshot is used. Sequential sends —
 * never parallel — so a large recipient set can't burst the mailer
 * provider's rate limit.
 *
 * A page-fetch (`findPage`) failure is NOT caught here; it propagates to the
 * caller. `announce` has always let a `findPage` failure abort that one
 * call — unchanged. The cron instead wraps each call to this helper in its
 * own per-step try/catch, so one step's transient DB error logs and moves on
 * to the next step/sequence instead of aborting the whole run (#4163).
 *
 * A per-recipient `sendProductMail` failure, by contrast, IS caught here —
 * logged and skipped, never stopping the walk — same contract `announce` has
 * always had.
 * @param {Object} filter - Mongo filter (already including the
 *   `emailVerified` / opt-out check and any caller-specific narrowing, e.g.
 *   the cron's per-step `createdAt` range)
 * @param {Object} mail - same shape as `sendProductMail`'s second argument
 * @param {'onboarding'|'news'} mail.kind - already-parsed `EmailKind`
 * @param {string} mail.template
 * @param {string} mail.subject
 * @param {Object} [mail.params]
 * @param {string} [mail.from]
 * @param {string|string[]} [mail.replyTo]
 * @param {Object} [options]
 * @param {number} [options.pageSize] - defaults to `ANNOUNCE_PAGE_SIZE`
 * @param {string} [options.logLabel] - prefix for the per-recipient warn log;
 *   defaults to `'users.announce'`
 * @param {Object} [options.logContext] - extra fields merged into the
 *   per-recipient warn log (e.g. the cron's `sequence`/`day`)
 * @returns {Promise<{sent: number, failed: number}>} counts of recipients
 *   actually mailed vs. recipients whose send threw
 */
const walkSendProductMail = async (filter, { kind, template, subject, params, from, replyTo }, { pageSize = ANNOUNCE_PAGE_SIZE, logLabel = 'users.announce', logContext = {} } = {}) => {
  const select = '_id email emailVerified emailPreferences';

  let sent = 0;
  let failed = 0;
  let afterId;
  let page;
  do {
    page = await UserRepository.findPage(filter, { afterId, limit: pageSize, select });

    for (const recipient of page) {
      try {
        // Sequential on purpose — see the JSDoc above (never parallel: avoid bursting the mailer provider).
        const result = await sendProductMail(recipient, { kind, template, subject, params, from, replyTo });
        if (result) sent += 1;
      } catch (err) {
        failed += 1;
        // recipient is a lean object (no `id` virtual) — _id is the only identifier available.
        logger.warn(`${logLabel}: send failed for one recipient`, { userId: String(recipient._id), kind, ...logContext, message: err?.message, stack: err?.stack });
      }
    }

    if (page.length > 0) afterId = page[page.length - 1]._id;
  } while (page.length === pageSize);

  return { sent, failed };
};

/**
 * @desc Send a product email to every verified user who has not opted out of
 * `kind` (#4162). Recipients are walked via `walkSendProductMail` instead of
 * one unbounded array load, so a large user base can't exhaust process
 * memory; each page's projection is limited to exactly what
 * `sendProductMail` reads (`_id`, `email`, `emailVerified`,
 * `emailPreferences`) — never the password hash or OAuth provider tokens.
 * A per-recipient send failure is logged and does NOT stop the loop; the
 * rest of the list still gets mailed.
 * @param {Object} mail
 * @param {'onboarding'|'news'} mail.kind
 * @param {string} mail.template
 * @param {string} mail.subject
 * @param {Object} [mail.params]
 * @param {string} [mail.from]
 * @param {string|string[]} [mail.replyTo]
 * @returns {Promise<{sent: number}>} count of recipients actually mailed
 *   (excludes per-recipient skips and failures)
 */
const announce = async ({ kind, template, subject, params, from, replyTo }) => {
  const parsedKind = EmailKind.parse(kind);
  const filter = {
    emailVerified: true,
    [`emailPreferences.${parsedKind}`]: { $ne: false },
  };

  const { sent } = await walkSendProductMail(filter, { kind: parsedKind, template, subject, params, from, replyTo });
  return { sent };
};

/**
 * @desc Set one `emailPreferences` kind for a user by id (#4162). Used by the
 * public one-click unsubscribe route, after the caller has already verified
 * the request's HMAC token — this function does no token handling itself.
 * @param {String} userId - the user id (from a verified unsubscribe token)
 * @param {String} kind - email kind ('onboarding' | 'news')
 * @param {Boolean} value - the new preference value
 * @returns {Promise<Object|null>} sanitized updated user, or null when the
 *   id is invalid or no user matched it
 */
const setEmailPreference = async (userId, kind, value) => {
  const parsedKind = EmailKind.parse(kind);
  const result = await UserRepository.setEmailPreference(userId, parsedKind, value);
  return result ? removeSensitive(result) : null;
};

/**
 * @desc Function to ask repository to sign terms for current user
 * @param {Object} user - original user document
 * @returns {Promise<Object>} updated user (sanitized)
 */
const terms = async (user) => {
  user = _.assignIn(user, { terms: new Date() });
  const result = await UserRepository.update(user);
  return removeSensitive(result);
};

/**
 * @desc Function to remove a user from db and clean up associated memberships/orgs
 * @param {Object} user - user document with _id or id field
 * @returns {Promise<Object>} deletion result
 */
const remove = async (user) => {
  const userId = user._id || user.id;

  // Clean up memberships and handle orphaned orgs before deleting the user
  const memberships = await MembershipService.listByUser(userId);
  for (const membership of memberships) {
    const orgId = membership.organizationId._id || membership.organizationId;
    if (membership.role === MEMBERSHIP_ROLES.OWNER) {
      // Check if this user is the only owner of the org
      const ownerCount = await MembershipService.count({ organizationId: orgId, role: MEMBERSHIP_ROLES.OWNER, status: MEMBERSHIP_STATUSES.ACTIVE });
      if (ownerCount <= 1) {
        // Sole owner — delete the org through the canonical removal seam rather than
        // duplicating its cascade here. organizations.crud.service.js#remove() owns the
        // full contract: membership cleanup, co-member currentOrganization reassignment,
        // and the org repository delete ALL happen first (atomic-by-ordering — the org
        // is never left half-removed), and only THEN do registered onOrganizationRemoved
        // handlers (e.g. task cleanup) run, best-effort — a handler failure is caught and
        // logged inside that service, never re-thrown (#3965).
        //
        // No try/catch here on purpose: because handler failures are already swallowed
        // (logged) inside the seam, anything that DOES escape this call is a STRUCTURAL
        // failure (membership wipe / reassignment / the org repository delete itself
        // throwing) — and that must propagate and abort this entire user deletion, same
        // as the pre-#3965 behavior, so a user is never deleted on top of an org whose
        // teardown genuinely broke.
        //
        // Lazy import: organizations.crud.service.js statically imports this module
        // (UserService), so a static import here would create a cycle. Matches the
        // lazy-import pattern already used for the same reason in billing.init.js /
        // billing.referral.service.js.
        const { default: OrganizationsCrudService } = await import('../../organizations/services/organizations.crud.service.js');
        await OrganizationsCrudService.remove({ _id: orgId });
        continue; // memberships for this org already cleaned up by the removal seam above
      }
    }
    // Delete this user's membership
    await MembershipService.deleteMany({ _id: membership._id });
  }

  // Sweep the user's PENDING rows (both join_request and owner_add). The cleanup
  // loop above iterates listByUser, which is ACTIVE-only — without this sweep a
  // deleted user's pending invitations / join requests would survive as orphans
  // pointing at a dead userId (and keep occupying the (user, org) unique slot).
  await MembershipRepository.deleteMany({ userId, status: MEMBERSHIP_STATUSES.PENDING });

  const result = await UserRepository.remove(user);
  return result;
};

/**
 * @desc Function to get all stats of db
 * @returns {Promise<Object>} user statistics
 */
const stats = async () => {
  const result = await UserRepository.stats();
  return result;
};

/**
 * @desc Exact user count (delegates to repository.count)
 * @param {Object} [filter] - optional Mongoose filter
 * @returns {Promise<number>} exact matching user count
 */
const count = (filter = {}) => UserRepository.count(filter);

/**
 * @desc Function to update a user by ID with a partial update object
 * @param {String} id - The user ID
 * @param {Object} data - Fields to update
 * @returns {Promise<Object>} update result
 */
const updateById = (id, data) => UserRepository.updateById(id, data);

/**
 * @desc Function to find users matching a filter with optional field selection
 * @param {Object} filter - Mongoose filter
 * @param {String} [select] - Fields to select
 * @returns {Promise<Array>} matching users
 */
const findWithFilter = (filter, select) => UserRepository.findWithFilter(filter, select);

/**
 * @desc Function to find a user by ID, update, and return the populated document
 * @param {String} id - The user ID
 * @param {Object} data - Fields to update
 * @param {String|Array|Object} populateFields - Fields to populate
 * @returns {Promise<Object>} updated user
 */
const findByIdAndUpdatePopulated = (id, data, populateFields) => UserRepository.findByIdAndUpdatePopulated(id, data, populateFields);

/**
 * @desc Function to search users by name or email
 * @param {String} search - The search string
 * @returns {Promise<Array>} matching user IDs
 */
const searchByNameOrEmail = (search) => UserRepository.searchByNameOrEmail(search);

/**
 * @desc Function to find a user by email address
 * @param {String} email - The email to search for
 * @returns {Promise<Object|null>} The matching user or null
 */
const findByEmail = (email) => UserRepository.findByEmail(email);

/**
 * @desc Atomically attach an OAuth provider to an existing user matched by email.
 * Uses a single findOneAndUpdate to avoid TOCTOU races between concurrent OAuth callbacks.
 * @param {string} email - The email to match
 * @param {string} provider - The OAuth provider key (e.g. 'google', 'apple')
 * @param {Object} providerData - The provider's identity data to store
 * @returns {Promise<Object|null>} sanitized updated user or null if no match
 */
const linkProviderByEmail = async (email, provider, providerData) => {
  const result = await UserRepository.linkProviderByEmail(email, provider, providerData);
  return result ? removeSensitive(result) : null;
};

// Named (non-default) export on purpose: an internal seam shared with
// `modules/users/crons/users.emailSequences.js` (#4163), not a public
// `UserService` operation — see the JSDoc above `walkSendProductMail`.
export { walkSendProductMail };

export default {
  list,
  create,
  search,
  get,
  getBrut,
  update,
  consumeEmailVerificationToken,
  sendProductMail,
  announce,
  setEmailPreference,
  terms,
  remove,
  stats,
  count,
  updateById,
  findWithFilter,
  findByIdAndUpdatePopulated,
  searchByNameOrEmail,
  findByEmail,
  linkProviderByEmail,
  removeSensitive,
};
