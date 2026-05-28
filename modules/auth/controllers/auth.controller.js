/**
 * Module dependencies
 */
import crypto from 'crypto';
import passport from 'passport';
import jwt from 'jsonwebtoken';

import UserService from '../../users/services/users.service.js';
import InvitationService from '../services/auth.invitation.service.js';
import config from '../../../config/index.js';
import model from '../../../lib/middlewares/model.js';
import mails from '../../../lib/helpers/mailer/index.js';
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

const tokenCookieOptions = {
  httpOnly: true,
  secure: config.cookie.secure,
  sameSite: config.cookie.sameSite,
};

/**
 * @desc Check whether the mailer is configured with a real sender address.
 * Delegates to the centralized helper in lib/helpers/mailer.
 * @returns {boolean} true when SMTP mail sending is available
 */
const isMailerConfigured = () => mails.isConfigured();

import getBaseUrl from '../../../lib/helpers/getBaseUrl.js';

/**
 * @desc Send a verification email to the user with a signed token link
 * @param {Object} user - User object (must have email, firstName, lastName)
 * @param {string} verificationToken - The email verification token
 * @returns {Promise<Object>} nodemailer send result
 */
const sendVerificationEmail = async (user, verificationToken) => {
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
 * @desc Endpoint to ask the service to create a user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const signup = async (req, res) => {
  try {
    // Two AND-ed gates: (1) capacity — a hard ceiling on total accounts,
    // invited users included; (2) eligibility — public signup open OR a valid
    // invite token (read from query: model.isValid strips unknown body keys).
    const total = await UserService.count();
    const capReached = config.sign.cap != null && total >= config.sign.cap;
    const invite = req.query.inviteToken ? await InvitationService.findValid(req.query.inviteToken, req.body.email) : null;
    if (capReached || (!config.sign.up && !invite)) {
      return responses.error(res, 404, 'Signup error', 'Registration is currently deactivated')();
    }
    // Force default role on public signup — clients must not self-assign admin
    const safeBody = { ...req.body, roles: ['user'] };
    const user = await UserService.create(safeBody);

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
      } else {
        // No mailer configured — auto-verify so dev/test are not blocked
        const brutUser = await UserService.getBrut({ id: user.id });
        await UserService.update(brutUser, { emailVerified: true }, 'recover');
        user.emailVerified = true;
      }
    } catch (verifyErr) {
      try { await UserService.remove(user); } catch (_cleanupErr) { /* best-effort */ }
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
        properties: { email: user.email, plan: user.plan, createdAt: user.createdAt },
      });
    } catch (_) { /* analytics must not break auth */ }

    // Single-use: consume only after the account is fully provisioned (best-effort)
    if (invite) await InvitationService.consume(invite.id);

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
 * @desc Endpoint for oautCall
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const oauthCall = (req, res, next) => {
  const strategy = req.params.strategy;
  passport.authenticate(strategy)(req, res, next);
};

/**
 * Known OAuth providers — used to validate the `provider` argument and `key` argument
 * before constructing dynamic query paths, preventing prototype-pollution-style injections.
 */
const ALLOWED_PROVIDERS = new Set(['google', 'apple']);
const ALLOWED_PROVIDER_KEYS = new Set(['sub', 'id', 'email']);

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
    if (!config.sign.up) {
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
    return await UserService.create(result.value);
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
  // app Auth with Strategy managed on client side
  if (req.body?.strategy === false && req.body?.key) {
    const allowedKeys = ['id', 'sub', 'email'];
    if (!allowedKeys.includes(req.body.key)) {
      return responses.error(res, 422, 'Unprocessable Entity', 'Invalid provider key')();
    }
    try {
      let user = {
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        email: req.body.email,
        providerData: {},
      };
      user.providerData[req.body.key] = req.body.value;
      user = await checkOAuthUserProfile(user, req.body.key, strategy);
      const token = jwt.sign({ userId: user.id }, config.jwt.secret, {
        expiresIn: config.jwt.expiresIn,
      });
      return res
        .status(200)
        .cookie('TOKEN', token, tokenCookieOptions)
        .json({
          user,
          tokenExpiresIn: Date.now() + config.jwt.expiresIn * 1000,
          type: 'success',
          message: 'oAuth Ok',
        });
    } catch (err) {
      return responses.error(
        res,
        422,
        err instanceof AppError && err.code === 'VALIDATION_ERROR' ? errors.getMessage(err) : 'Unprocessable Entity',
        errors.getMessage(err.details || err),
      )(err);
    }
  }
  // classic web oAuth
  passport.authenticate(strategy, (err, user) => {
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
 * @returns {void} Sends the public auth configuration in the HTTP response
 */
const getConfig = (req, res) => {
  const data = {
    sign: {
      in: !!config.sign.in,
      up: !!config.sign.up,
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
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
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
