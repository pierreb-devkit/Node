/**
 * Module dependencies
 */
import crypto from 'crypto';
import passport from 'passport';
import jwt from 'jsonwebtoken';

import UserService from '../../users/services/users.service.js';
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

const tokenCookieOptions = {
  httpOnly: true,
  secure: config.cookie.secure,
  sameSite: config.cookie.sameSite,
};

/**
 * @desc Check whether the mailer is configured with a real sender address
 * @returns {boolean} true when SMTP mail sending is available
 */
const isMailerConfigured = () => !!(config.mailer && config.mailer.from && !config.mailer.from.startsWith('DEVKIT_NODE_'));

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
      displayName: `${user.firstName} ${user.lastName}`,
      url: `${config.cors.origin[0]}/verify-email?token=${verificationToken}`,
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
    if (!config.sign.up) return responses.error(res, 404, 'Signup error', 'Registration is currently deactivated')();
    // Force default role on public signup — clients must not self-assign admin
    const { roles: _roles, ...safeBody } = req.body;
    safeBody.roles = ['user'];
    const user = await UserService.create(safeBody);

    // Handle email verification
    if (isMailerConfigured()) {
      // Generate verification token and persist it
      const verificationToken = crypto.randomBytes(20).toString('hex');
      const brutUser = await UserService.getBrut({ id: user.id });
      await UserService.update(brutUser, {
        emailVerificationToken: verificationToken,
        emailVerificationExpires: Date.now() + 24 * 3600000, // 24 hours
      }, 'recover');
      // Send verification email (best-effort, do not block signup)
      sendVerificationEmail(user, verificationToken).catch(() => {});
    } else {
      // No mailer configured — auto-verify so dev/test are not blocked
      const brutUser = await UserService.getBrut({ id: user.id });
      await UserService.update(brutUser, { emailVerified: true }, 'recover');
      user.emailVerified = true;
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
        suggestedOrganization: orgResult.suggestedOrganization || null,
        type: 'sucess',
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
  // eslint-disable-next-line no-unused-vars
  passport.authenticate('local', { session: false }, (err, user, info) => {
    if (err && err.code === 'ACCOUNT_LOCKED') {
      return responses.error(res, 423, 'Account locked', err.details?.message || 'Account is locked. Try again later.')(err);
    }
    if (err) {
      return responses.error(res, 500, 'Internal Server Error', errors.getMessage(err))(err);
    }
    if (!user) {
      return res.status(401).send('Unauthorized');
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
      type: 'sucess',
      message: 'Sign in',
    });
};

/**
 * @desc Endpoint to get a new token if old is ok
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * TODO: escape deprecated
 */
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
      additionalProvidersData: req.user.additionalProvidersData,
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
 * @desc Endpoint to save oAuthProfile
 * @param {Object} profil - OAuth user profile object
 * @param {string} key - Provider key to lookup providerData
 * @param {string} provider - OAuth provider name
 */
const checkOAuthUserProfile = async (profil, key, provider) => {
  // check if user exist
  try {
    const query = {};
    query[`providerData.${key}`] = profil.providerData[key];
    query.provider = provider;
    const search = await UserService.search(query);
    if (search.length === 1) return search[0];
  } catch (err) {
    throw new AppError('oAuth, find user failed', { code: 'SERVICE_ERROR', details: err });
  }
  // if no, generate
  try {
    const user = {
      firstName: profil.firstName,
      lastName: profil.lastName,
      email: profil.email,
      avatar: profil.avatar || '',
      provider,
      providerData: profil.providerData || null,
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
 * @desc Endpoint for oautCallCallBack
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const oauthCallback = async (req, res, next) => {
  const strategy = req.params.strategy;
  // app Auth with Strategy managed on client side
  if (req.body.strategy === false && req.body.key) {
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
          type: 'sucess',
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
    const url = config.cors.origin[0];
    if (err) {
      const _err = JSON.stringify(err);
      const path = 'token?message=Unprocessable%20Entity';
      res.redirect(302, `${url}/${path}&error=${_err}`);
    } else if (!user) {
      const _err = JSON.stringify(err);
      const path = 'token?message=Could%20not%20define%20user%20in%20oAuth';
      res.redirect(302, `${url}/${path}&error=${_err}`);
    } else {
      const token = jwt.sign({ userId: user.id }, config.jwt.secret, {
        expiresIn: config.jwt.expiresIn,
      });
      res.cookie('TOKEN', token, tokenCookieOptions);
      res.redirect(302, `${config.cors.origin[0]}/token`);
    }
  })(req, res, next);
};

/**
 * @desc Endpoint to expose public auth configuration (sign flags and organizations settings)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void} Sends the public auth configuration in the HTTP response
 */
const getConfig = (_req, res) => {
  responses.success(res, 'Auth config')({
    sign: {
      in: !!config.sign.in,
      up: !!config.sign.up,
    },
    organizations: {
      enabled: !!config.organizations.enabled,
      domainMatching: !!config.organizations.domainMatching,
      roles: config.organizations.roles,
      roleDescriptions: config.organizations.roleDescriptions,
    },
    mail: {
      configured: isMailerConfigured(),
    },
  });
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
    if (!user || !user.email) return responses.error(res, 400, 'Bad Request', 'Email verification token is invalid or has expired.')();
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
    if (!mail.accepted) return responses.error(res, 400, 'Bad Request', 'Failure sending email')();
    return responses.success(res, 'Verification email sent')({ status: true });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

export default {
  signup,
  signinAuthenticate,
  signin,
  token,
  oauthCall,
  oauthCallback,
  checkOAuthUserProfile,
  getConfig,
  verifyEmail,
  resendVerification,
};
