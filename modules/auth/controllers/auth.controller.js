/**
 * Module dependencies
 */
import crypto from 'crypto';
import passport from 'passport';
import jwt from 'jsonwebtoken';

import UserService from '../../users/services/users.service.js';
import Eligibility from '../services/auth.eligibility.js';
import { computeSignupCapacity } from '../services/auth.signupCapacity.js';
import SignupService, { isMailerConfigured, sendVerificationEmail } from '../services/auth.signup.service.js';
import config from '../../../config/index.js';
import model from '../../../lib/middlewares/model.js';
import responses from '../../../lib/helpers/responses.js';
import errors from '../../../lib/helpers/errors.js';
import AppError from '../../../lib/helpers/AppError.js';
import UsersSchema from '../../users/models/users.schema.js';
import policy from '../../../lib/middlewares/policy.js';
import serializeAbilities from '../../../lib/helpers/abilities.js';
import AuthOrganizationService from '../../organizations/services/organizations.service.js';
import OrganizationCrudService from '../../organizations/services/organizations.crud.service.js';
import MembershipService from '../../organizations/services/organizations.membership.service.js';
import AnalyticsService from '../../../lib/services/analytics.js';
import logger from '../../../lib/services/logger.js';
import getBaseUrl from '../../../lib/helpers/getBaseUrl.js';

const tokenCookieOptions = {
  httpOnly: true,
  secure: config.cookie.secure,
  sameSite: config.cookie.sameSite,
};

/**
 * @desc Endpoint to ask the service to create a user. Business logic lives in
 * auth.signup.service.js — this handler only invokes it and shapes the HTTP
 * response (token + cookie + JSON body) or maps a thrown error to a status.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<Object|undefined>} on the success path, the Express
 *   response object (chained from res.json()); on the SIGNUP_DISABLED gate
 *   path, the plain result object returned by responses.error() ({type,
 *   message, code, status, errorCode, description} — not `res` itself);
 *   undefined on the generic 422 fallback, which has no explicit return
 *   (the error response is still sent as a side effect either way)
 */
const signup = async (req, res) => {
  try {
    const { user, orgResult } = await SignupService.signup(req);

    const token = jwt.sign({ userId: user.id }, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });

    // If the org set currentOrganization, reflect it on the returned user
    // (but NOT for pendingJoin — user has no active membership yet)
    if (orgResult.organization && !orgResult.pendingJoin) {
      user.currentOrganization = orgResult.organization._id || orgResult.organization.id;
    }

    return res
      .status(200)
      .cookie('TOKEN', token, tokenCookieOptions)
      .json({
        user,
        tokenExpiresIn: Date.now() + config.jwt.expiresIn * 1000,
        organization: orgResult.organization || null,
        joined: orgResult.joined || false,
        pendingJoin: orgResult.pendingJoin || false,
        abilities: orgResult.abilities || [],
        organizationSetupRequired: orgResult.organizationSetupRequired || false,
        emailVerificationRequired: orgResult.emailVerificationRequired || false,
        // deprecated: always null since always-create (A2); superseded by suggestedJoin — remove next release
        suggestedOrganization: orgResult.suggestedOrganization || null,
        suggestedJoin: orgResult.suggestedJoin || null,
        type: 'success',
        message: 'Sign up',
      });
  } catch (err) {
    // The capacity/eligibility gate (auth.signup.service.js) signals via this code
    // so the ORIGINAL 404 response is reproduced byte-for-byte — status, title,
    // description, and no `err` argument to responses.error (matches the inline
    // call this replaced) — instead of falling through to the generic 422 mapping
    // below. Every distinct error status this flow can produce keeps its own
    // status/title/message; none are collapsed into a shared helper.
    if (err?.code === 'SIGNUP_DISABLED') {
      return responses.error(res, 404, 'Signup error', 'Registration is currently deactivated')();
    }
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Middleware that runs passport local authentication and intercepts account-locked errors
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void} Calls next on success or sends a 423/401/500 response on failure
 */
const signinAuthenticate = (req, res, next) => {
  passport.authenticate('local', { session: false }, (err, user, info) => {
    if (err && err.code === 'ACCOUNT_LOCKED') {
      return responses.error(res, 423, 'Account locked', err.details?.message || 'Account is locked. Try again later.')(err);
    }
    if (err) {
      return responses.error(res, 500, 'Internal Server Error', errors.getMessage(err))(err);
    }
    if (!user) {
      return responses.error(res, 401, 'Unauthorized', info?.message || 'Unauthorized')();
    }
    req.user = user;
    return next();
  })(req, res, next);
};

/**
 * @desc Endpoint to ask the service to connect a user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const signin = async (req, res) => {
  if (!config.sign.in) return responses.error(res, 404, 'Signin error', 'Login is currently deactivated')();
  const user = req.user;

  // Auto-set currentOrganization if missing but active memberships exist
  await OrganizationCrudService.autoSetCurrentOrganization(user);

  // Load active membership for current organization to build abilities
  let membership = null;
  if (user.currentOrganization) {
    membership = await MembershipService.findByUserAndOrganization(
      user._id || user.id,
      user.currentOrganization._id || user.currentOrganization,
    );
  }

  // Analytics — fire-and-forget, never break signin flow
  try {
    AnalyticsService.identify(String(user.id || user._id), {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      lastLoginAt: user.lastLoginAt,
    });
    AnalyticsService.capture({ distinctId: String(user.id || user._id), event: 'user_signed_in' });
  } catch (_) { /* analytics must not break auth */ }

  const token = jwt.sign({ userId: user.id }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
  const ability = await policy.defineAbilityFor(user, membership);
  const abilities = serializeAbilities(ability);

  // If user has no org, check for pending join requests
  let pendingRequests = [];
  if (!user.currentOrganization && config.organizations?.enabled) {
    pendingRequests = await MembershipService.listPendingByUser(user._id || user.id);
  }

  return res
    .status(200)
    .cookie('TOKEN', token, tokenCookieOptions)
    .json({
      user,
      tokenExpiresIn: Date.now() + config.jwt.expiresIn * 1000,
      abilities,
      pendingRequests: pendingRequests.length > 0 ? pendingRequests : undefined,
      type: 'success',
      message: 'Sign in',
    });
};

/**
 * @desc Endpoint to get a new token if old is ok
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * TODO: escape deprecated
 */
/**
 * @desc Strip OAuth tokens from an additionalProvidersData map before serializing to client.
 * Only the provider identity fields are safe to expose; access/refresh tokens must stay server-side.
 * @param {Object|undefined} apd - raw additionalProvidersData
 * @returns {Object|undefined} sanitized map with accessToken/refreshToken removed per provider
 */
const sanitizeAdditionalProvidersData = (apd) => {
  if (!apd || typeof apd !== 'object') return undefined;
  const sanitized = {};
  for (const [prov, data] of Object.entries(apd)) {
    if (data && typeof data === 'object') {
      // eslint-disable-next-line no-unused-vars
      const { accessToken, refreshToken, ...safe } = data;
      sanitized[prov] = safe;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

const token = async (req, res) => {
  let user = null;
  if (req.user) {
    // Auto-set currentOrganization if missing but active memberships exist
    await OrganizationCrudService.autoSetCurrentOrganization(req.user);

    user = {
      id: req.user.id,
      provider: req.user.provider,
      roles: req.user.roles,
      avatar: req.user.avatar,
      email: req.user.email,
      lastName: req.user.lastName,
      firstName: req.user.firstName,
      additionalProvidersData: sanitizeAdditionalProvidersData(req.user.additionalProvidersData),
      emailVerified: req.user.emailVerified,
      currentOrganization: req.user.currentOrganization,
      lastLoginAt: req.user.lastLoginAt,
      complementary: req.user.complementary,
    };
  }

  // Load active membership for current organization to build abilities
  let membership = null;
  if (req.user && req.user.currentOrganization) {
    membership = await MembershipService.findByUserAndOrganization(
      req.user._id || req.user.id,
      req.user.currentOrganization._id || req.user.currentOrganization,
    );
  }

  const token = jwt.sign({ userId: user.id }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
  const ability = await policy.defineAbilityFor(req.user, membership);
  const abilities = serializeAbilities(ability);

  // If user has no org, include pending join requests
  let pendingRequests;
  if (req.user && !req.user.currentOrganization && config.organizations?.enabled) {
    const requests = await MembershipService.listPendingByUser(req.user._id || req.user.id);
    if (requests.length > 0) pendingRequests = requests;
  }

  return res
    .status(200)
    .cookie('TOKEN', token, tokenCookieOptions)
    .json({ user, tokenExpiresIn: Date.now() + config.jwt.expiresIn * 1000, abilities, pendingRequests });
};

/**
 * Known OAuth providers — used to validate the `provider` argument and `key` argument
 * before constructing dynamic query paths, preventing prototype-pollution-style injections.
 */
const ALLOWED_PROVIDERS = new Set(['google', 'apple']);
const ALLOWED_PROVIDER_KEYS = new Set(['sub', 'id', 'email']);

/**
 * @desc Check whether `:strategy` (from `req.params.strategy`) is both an allowlisted
 * provider AND actually registered with passport at boot time. A provider in
 * ALLOWED_PROVIDERS is only registered (modules/auth/strategies/local/{provider}.js)
 * when its config carries valid credentials — otherwise passport never sees it.
 * Guards the `/api/auth/:strategy` and `/api/auth/:strategy/callback` routes so an
 * unknown or disabled strategy name is rejected with a clean 404 before it can reach
 * passport.authenticate(), which otherwise throws synchronously ("Unknown
 * authentication strategy") for an unregistered name.
 * `passport._strategy` is documented `@api private` in passport's own source, but it
 * is the single source of truth for "is this strategy registered" — asking config
 * directly would mean duplicating each provider's own credential-presence check here
 * and risking drift from modules/auth/strategies/local/*.js over time.
 * @param {string} strategy - strategy name from req.params.strategy
 * @returns {boolean} true when strategy is both allowlisted and registered with passport
 */
const isEnabledOAuthProvider = (strategy) => ALLOWED_PROVIDERS.has(strategy) && Boolean(passport._strategy(strategy));

/**
 * @desc Endpoint for oautCall
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const oauthCall = (req, res, next) => {
  const strategy = req.params.strategy;
  if (!isEnabledOAuthProvider(strategy)) {
    return next(new AppError('oAuth, unsupported provider', { status: 404, code: 'OAUTH_PROVIDER_NOT_FOUND' }));
  }
  // session: false — stateless JWT stack, no express-session middleware is mounted.
  return passport.authenticate(strategy, { session: false })(req, res, next);
};

/**
 * @desc Resolve or create a user from an OAuth profile. Lookup order:
 *   1. Primary identity (provider + providerData[key])
 *   2. Linked identity (additionalProvidersData[provider][key])
 *   3. Link-on-verified-email (provider-verified email matches an existing local user)
 *   4. Create new user
 * @param {Object} profil - OAuth user profile object
 * @param {string} key - Provider key to lookup providerData (must be in ALLOWED_PROVIDER_KEYS)
 * @param {string} provider - OAuth provider name (must be in ALLOWED_PROVIDERS)
 * @returns {Promise<Object>} sanitized user document (existing, linked, or newly created)
 */
const checkOAuthUserProfile = async (profil, key, provider) => {
  // Guard: validate provider and key against allowlists before using as dynamic object keys
  if (!ALLOWED_PROVIDERS.has(provider)) {
    throw new AppError('oAuth, unsupported provider', { code: 'VALIDATION_ERROR', details: { provider } });
  }
  if (!ALLOWED_PROVIDER_KEYS.has(key)) {
    throw new AppError('oAuth, unsupported provider key', { code: 'VALIDATION_ERROR', details: { key } });
  }
  // 1. Primary identity: match on (provider, providerData[key]) — OAuth-first users
  try {
    const query = {};
    query[`providerData.${key}`] = profil.providerData[key];
    query.provider = provider;
    const search = await UserService.search(query);
    if (search.length === 1) return search[0];
  } catch (err) {
    throw new AppError('oAuth, find user failed', { code: 'SERVICE_ERROR', details: err });
  }
  // 2. Linked identity: match on additionalProvidersData[provider][key] — locals already linked
  try {
    const query = {};
    query[`additionalProvidersData.${provider}.${key}`] = profil.providerData[key];
    const search = await UserService.search(query);
    if (search.length === 1) return search[0];
  } catch (err) {
    throw new AppError('oAuth, find linked user failed', { code: 'SERVICE_ERROR', details: err });
  }
  // 3. Link on verified email: if a local user exists with the same email AND is
  //    already emailVerified locally AND the OAuth provider vouches for the email,
  //    attach providerData under additionalProvidersData.{provider} without
  //    overwriting user.provider (keeps password reset + local login intact).
  //    Atomic findOneAndUpdate (filter includes emailVerified: true) avoids TOCTOU
  //    races and prevents an unverified-squatter local account from being annexed
  //    by a later OAuth signin (issue #3504). If a matching email exists but is
  //    not locally verified, we reject with VALIDATION_ERROR rather than fall
  //    through to branch 4 (which would later fail on the unique-email index).
  if (profil.email && profil.emailVerifiedByProvider) {
    try {
      const linked = await UserService.linkProviderByEmail(profil.email, provider, profil.providerData);
      if (linked) return linked;
      // Link returned null → either no local user with this email, or the local
      // user exists but is not emailVerified. Disambiguate so we can reject the
      // squatter case explicitly instead of falling through to branch 4 (which
      // would later fail on the unique-email index with a less actionable error).
      const existing = await UserService.findByEmail(profil.email);
      if (existing && !existing.emailVerified) {
        throw new AppError('oAuth, cannot link to unverified local account', {
          code: 'VALIDATION_ERROR',
          details: {
            message: 'A pending account with this email is not verified. Verify the original signup first or contact support.',
          },
        });
      }
      // If `existing` is emailVerified here, a rare race between the atomic
      // findOneAndUpdate and this findByEmail let verification complete in
      // between. Falling through is safe: branch 4 will fail on the unique
      // email index, the OAuth client will see the error, and a retry will
      // hit the now-linkable state via branch 3.
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('oAuth, link to existing user failed', { code: 'SERVICE_ERROR', details: err });
    }
  }
  // 4. No match → create new user
  try {
    // Same two gates as local signup. OAuth can't carry an invite token through
    // the redirect, so the invite is matched on the provider's verified email.
    // E4: cap via computeSignupCapacity (single source of truth shared with getConfig
    // and the local signup path) — a BLANK cap ('') means UNCAPPED, not 0. The old
    // inline Number('')→0 hard-rejected every OAuth signup while getConfig advertised
    // the deployment as open. Same accepted small-beta TOCTOU overshoot as local signup.
    const { cap: oauthCap, remaining: oauthRemaining } = await computeSignupCapacity(config.sign?.cap, UserService.count);
    const capReached = oauthCap != null && oauthCap > 0 && oauthRemaining <= 0;
    // Only honor an OAuth invite when the provider verified the email — otherwise a
    // provider returning an arbitrary unverified email could open the gate on an
    // invite meant for someone else.
    const hasVerifiedProviderEmail = !!(profil.email && profil.emailVerifiedByProvider);
    // Eligibility via the generic hook (auth never imports invitation code). OAuth
    // carries no token through the redirect, so the invite is matched on the
    // provider-verified email — the checker honors it only when emailVerifiedByProvider.
    // Skip the hook entirely when signup is open: a token/invite is presented but not
    // required, and resolving one would silently burn it (preserves prior short-circuit).
    // The checker returns `{ invite, finalize, release }` (opaque to auth); no synthetic req carrier.
    let oauthEligibility = null;
    if (!config.sign.up) {
      oauthEligibility = await Eligibility.assertSignupEligible({
        email: profil.email,
        oauth: { emailVerifiedByProvider: hasVerifiedProviderEmail },
      });
    }
    const oauthInvite = oauthEligibility?.invite || null;
    if (capReached || (!config.sign.up && !oauthInvite)) {
      // Mirror the local signup endpoint's error shape so clients see the same
      // `message`/`description` regardless of signup method (see `signup` above).
      throw new AppError('Signup error', {
        code: 'VALIDATION_ERROR',
        details: { message: 'Registration is currently deactivated' },
      });
    }
    const user = {
      firstName: profil.firstName,
      lastName: profil.lastName,
      email: profil.email,
      avatar: profil.avatar || '',
      provider,
      providerData: profil.providerData || null,
      emailVerified: !!profil.emailVerifiedByProvider,
    };
    const result = model.getResultFromZod(user, UsersSchema.User);
    // check error
    const error = model.checkError(result);
    if (error) throw new AppError('Schema validation error', { code: 'VALIDATION_ERROR', details: { message: error } });
    // else return req.body with the data after Zod validation
    if (oauthInvite) result.value.email = oauthInvite.email;
    const createdUser = await UserService.create(result.value);

    // Analytics — fire-and-forget, never break auth. Mirrors the local signup
    // event (#4002/#4003); OAuth carries no attribution (the redirect has no
    // body to carry it in), so no attribution properties here. This MUST only
    // fire on THIS branch (new account) — never on branches 1-3 above, which
    // resolve to an existing/linked user and are not a signup.
    try {
      AnalyticsService.identify(String(createdUser.id), {
        email: createdUser.email,
        firstName: createdUser.firstName,
        lastName: createdUser.lastName,
        provider: createdUser.provider,
      });
      AnalyticsService.capture({
        distinctId: String(createdUser.id),
        event: 'user_signed_up',
        properties: {
          email: createdUser.email,
          plan: createdUser.plan,
          createdAt: createdUser.createdAt,
          provider: createdUser.provider,
          invited: Boolean(oauthInvite),
          invitationId: oauthInvite ? String(oauthInvite.id) : null,
          invitedBy: oauthInvite?.invitedBy ? String(oauthInvite.invitedBy) : null,
        },
      });
    } catch (_) { /* analytics must not break auth */ }

    // E2: FINALIZE through the returned closure (invitations owns it; auth stays
    // import-free). OAuth resolves the invite by the provider-verified email and
    // never CLAIMS it (no token on the redirect), so there is no consumingAt to
    // release on failure here — finalize marks it accepted+used (single-use). The
    // finalize filter (acceptedAt:null) + the unique-email index are the single-use
    // backstop against two concurrent OAuth signups for the same invited email.
    // finalize itself is best-effort (see catch below).
    if (oauthInvite) {
      try {
        await oauthEligibility?.finalize?.(createdUser._id || createdUser.id);
      } catch (finalizeErr) {
        // Best-effort: the account exists and the response is about to succeed —
        // a finalize DB hiccup must not convert a created account into a 422.
        // The claim stays stamped and the 15-min lazy sweep releases it; the
        // invite is reconcilable from its pending state + the account's email.
        logger.warn('[oauth] invite finalize failed post-create (left to the sweep)', {
          userId: String(createdUser._id || createdUser.id),
          err: finalizeErr?.message,
          stack: finalizeErr?.stack,
        });
      }
    }
    return createdUser;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('oAuth', { code: 'CONTROLLER_ERROR', details: err.details || err });
  }
};

/**
 * @desc Build a redirect URL carrying the canonical `responses.error` error envelope
 * and push the browser to `/token?...`. The payload mirrors the shape returned by
 * `lib/helpers/responses.js` so the Vue client can parse OAuth failures the same
 * way as any other API error.
 *
 * @param {Object} res - Express response object
 * @param {Object|null} err - AppError (or plain Error) raised by passport / strategy; may be null
 * @param {string} fallbackTitle - Human-readable title used when `err?.message` is missing
 * @returns {void} triggers a 302 redirect to `${baseUrl}/token?...`
 */
const oauthErrorRedirect = (res, err, fallbackTitle) => {
  const title = err?.message || fallbackTitle;
  const descriptionFromDetails = typeof err?.details?.message === 'string' ? err.details.message : '';
  // OAuth callback failures are surfaced as a 302 redirect (not a JSON 422), so
  // there is no live HTTP status — we embed 422 to match the canonical shape of
  // a Zod / AppError validation failure elsewhere in the API.
  const payload = {
    type: 'error',
    message: title,
    code: 422,
    status: 422,
    errorCode: err?.code || 'OAUTH_ERROR',
    description: descriptionFromDetails,
    // Legacy shape — the current Vue `token.view.vue` parser reads `details.message`.
    // Remove this field once all downstream Vue deploys have adopted the canonical
    // `responses.error` parser (tracked in Vue issue #4021).
    details: { message: descriptionFromDetails || title },
  };
  // Build the redirect URL via the `URL` constructor so the origin + path stay
  // server-controlled (`getBaseUrl()` resolves from `config.cors.origin`). User
  // input only flows into the query string, fully encoded by `URLSearchParams`,
  // so this is not an open-redirect sink.
  const target = new URL('/token', getBaseUrl());
  target.searchParams.set('message', title);
  target.searchParams.set('error', JSON.stringify(payload));
  res.redirect(302, target.toString());
};

/**
 * @desc Endpoint for oautCallCallBack
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const oauthCallback = async (req, res, next) => {
  const strategy = req.params.strategy;
  if (!isEnabledOAuthProvider(strategy)) {
    return next(new AppError('oAuth, unsupported provider', { status: 404, code: 'OAUTH_PROVIDER_NOT_FOUND' }));
  }
  // The identity is always derived server-side from the provider's response via
  // passport.authenticate(). The part that was previously unsafe was trusting a
  // client-asserted identity from the request body (email, key, value) with no
  // provider-token verification — a caller who knows a victim's identifier could
  // have minted that victim's session. That branch is now removed entirely.
  // No `{ session: false }` here: passport.authenticate()'s callback form (a
  // function as the 2nd/3rd arg) never calls req.logIn() itself — session
  // establishment is entirely the caller's responsibility below (JWT + cookie,
  // no express-session) — so the `session` option has nothing to act on.
  return passport.authenticate(strategy, (err, user) => {
    if (err) {
      logger.error(
        { err: { message: err?.message, code: err?.code, stack: err?.stack }, strategy },
        'OAuth callback failed',
      );
      return oauthErrorRedirect(res, err, 'oAuth error');
    }
    if (!user) {
      logger.error(
        { err: { message: err?.message, code: err?.code, stack: err?.stack }, strategy },
        'OAuth callback failed',
      );
      return oauthErrorRedirect(res, null, 'Could not define user in oAuth');
    }
    const token = jwt.sign({ userId: user.id }, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });
    res.cookie('TOKEN', token, tokenCookieOptions);
    return res.redirect(302, `${getBaseUrl()}/token`);
  })(req, res, next);
};

/**
 * @desc Endpoint to clear the JWT TOKEN cookie on the client.
 * No JWT middleware is required — signout must work even when the token is
 * expired, invalid, or missing. clearCookie options mirror tokenCookieOptions
 * because browsers only delete cookies whose secure/sameSite/path attributes
 * match the Set-Cookie used at login.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void} Sends a 200 JSON response and clears the TOKEN cookie
 */
const signout = (req, res) => {
  res.clearCookie('TOKEN', tokenCookieOptions);
  return res.status(200).json({ type: 'success', message: 'Signed out' });
};

/**
 * @desc Endpoint to expose public auth configuration (sign flags and organizations settings)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends the public auth configuration in the HTTP response
 */
const getConfig = async (req, res) => {
  try {
    const { cap, remaining } = await computeSignupCapacity(config.sign?.cap, UserService.count);
    const data = {
      sign: {
        in: !!config.sign.in,
        up: !!config.sign.up,
        cap, // null = uncapped; numeric = hard ceiling on total accounts (invited included)
        remaining, // null = uncapped; else max(0, cap - totalAccounts)
      },
      oAuth: {
        google: !!config.oAuth?.google?.clientID,
        apple: !!config.oAuth?.apple?.clientID,
      },
      organizations: {
        enabled: !!config.organizations?.enabled,
        domainMatching: !!config.organizations?.domainMatching,
        autoCreate: !!config.organizations?.autoCreate,
      },
      mail: {
        configured: isMailerConfigured(),
      },
      app: {
        version: (() => {
          const v = config.app?.version;
          if (v && !String(v).startsWith('DEVKIT_NODE_')) return v;
          return config.package?.version || 'dev';
        })(),
      },
      // #3981: same top-level, unauthenticated pattern as `sign` above — the invitations
      // module's own README (point 3) documents that its Vue Referrals tab already reads
      // `sign.up` from this same endpoint to decide whether the open-signup deployment
      // can still convert referrals; `userFacing` is the second half of that gate. Expose
      // ONLY this boolean — nothing else from `config.invitations` (rate-limit tuning,
      // etc.) is public API surface.
      invitations: {
        userFacing: !!config.invitations?.userFacing,
      },
    };

    // Authenticated users get extended org config and billing config
    if (req.user) {
      data.organizations = {
        ...data.organizations,
        roles: config.organizations?.roles || [],
        roleDescriptions: config.organizations?.roleDescriptions || {},
      };
      data.billing = {
        enabled: !!config.billing?.enabled,
        meterMode: !!config.billing?.meterMode,
        equivalences: config.billing?.equivalences ?? null,
      };
    }

    responses.success(res, 'Auth config')(data);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to verify a user email address using a token
 * @param {Object} req - Express request object (req.params.token)
 * @param {Object} res - Express response object
 * @returns {void} Sends JSON response indicating verification success or failure
 */
const verifyEmail = async (req, res) => {
  try {
    const user = await UserService.getBrut({ emailVerificationToken: req.params.token });
    const isExpired = !user?.emailVerificationExpires || Number(user.emailVerificationExpires) < Date.now();
    if (!user || !user.email || isExpired) {
      return responses.error(res, 400, 'Bad Request', 'Email verification token is invalid or has expired.')();
    }
    await UserService.update(user, {
      emailVerified: true,
      emailVerificationToken: null,
      emailVerificationExpires: null,
    }, 'recover');
    // Mark verified on the local object so handleSignupOrganization sees emailVerified=true
    user.emailVerified = true;

    // Post-verification org setup — provision org/grant if not yet done (best-effort).
    // handleSignupOrganization is idempotent: if the org already exists it converges
    // without double-crediting. Failure must never block email verification success.
    try {
      await AuthOrganizationService.handleSignupOrganization(user);
    } catch (orgErr) {
      logger.warn('[auth.verifyEmail] org/grant provisioning failed (non-fatal)', {
        userId: user.id,
        error: orgErr?.message,
      });
    }

    return responses.success(res, 'Email verified successfully')({ emailVerified: true });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to resend the verification email for the authenticated user
 * @param {Object} req - Express request object (req.user must be set)
 * @param {Object} res - Express response object
 * @returns {void} Sends JSON response confirming the email was resent or an error
 */
const resendVerification = async (req, res) => {
  try {
    const user = await UserService.getBrut({ id: req.user.id });
    if (!user || !user.email) return responses.error(res, 400, 'Bad Request', 'User not found')();
    if (user.emailVerified) return responses.error(res, 400, 'Bad Request', 'Email is already verified')();
    if (!isMailerConfigured()) return responses.error(res, 400, 'Bad Request', 'Mail service is not configured')();

    const verificationToken = crypto.randomBytes(20).toString('hex');
    await UserService.update(user, {
      emailVerificationToken: verificationToken,
      emailVerificationExpires: Date.now() + 24 * 3600000, // 24 hours
    }, 'recover');
    const mail = await sendVerificationEmail(user, verificationToken);
    const acceptedCount = Array.isArray(mail?.accepted) ? mail.accepted.length : 0;
    if (!acceptedCount) return responses.error(res, 400, 'Bad Request', 'Failure sending email')();
    return responses.success(res, 'Verification email sent')({ status: true });
  } catch (err) {
    // #3966 hardening: sendVerificationEmail (mailer.sendMail) now propagates a
    // transport failure instead of swallowing it — the raw SMTP/provider error
    // string must not leak to the client. Log the real error server-side with
    // context (this catch is resend-email-scoped: an unexpected failure here is
    // effectively always the mail send); respond with a stable generic message.
    logger.error('[auth.resendVerification] failed', {
      userId: req.user?.id,
      message: err?.message,
      stack: err?.stack,
    });
    responses.error(res, 422, 'Unprocessable Entity', 'Failed to send the email, please try again.')(err);
  }
};

export default {
  signup,
  signinAuthenticate,
  signin,
  signout,
  token,
  oauthCall,
  oauthCallback,
  checkOAuthUserProfile,
  getConfig,
  verifyEmail,
  resendVerification,
};
