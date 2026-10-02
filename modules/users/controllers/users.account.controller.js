/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import UserService from '../services/users.service.js';
import { verifyUnsubscribeToken } from '../utils/unsubscribeToken.js';

/**
 * @desc Endpoint to ask the service to update a user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const update = async (req, res) => {
  try {
    const user = await UserService.update(req.user, req.body);
    // reset login
    req.login(user, { session: false }, (errLogin) => {
      if (errLogin) return responses.error(res, 400, 'Bad Request', errors.getMessage(errLogin))(errLogin);
      return responses.success(res, 'user updated')(user);
    });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to ask the service to update the terms sign of the user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const terms = async (req, res) => {
  try {
    const user = await UserService.terms(req.user);
    responses.success(res, 'user terms signed')(user);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to ask the service to remove the user connected
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const remove = async (req, res) => {
  try {
    const result = await UserService.remove(req.user);
    responses.success(res, 'user deleted')({ id: req.user.id, ...result });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to ask the service to sanitize the user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const me = (req, res) => {
  // Sanitize the user - short term solution. Copied from core.controller.js
  // TODO create proper passport mock: See https://gist.github.com/mweibel/5219403
  // providerData (OAuth access+refresh tokens, see auth/strategies/local/{google,apple}.js)
  // is intentionally NOT whitelisted here — never forward it to the client (#3963).
  let user = null;
  if (req.user) {
    user = {
      id: req.user.id,
      provider: req.user.provider,
      roles: req.user.roles,
      avatar: req.user.avatar,
      email: req.user.email,
      lastName: req.user.lastName,
      firstName: req.user.firstName,
      // others
      complementary: req.user.complementary,
      // #4162 — self-editable, so (like complementary) always reflected back;
      // undefined for a user who never touched it (absent = every kind on).
      emailPreferences: req.user.emailPreferences,
    };
    if (req.user.bio) user.bio = req.user.bio;
    if (req.user.position) user.position = req.user.position;
    // startup requirement
    if (req.user.terms) user.terms = req.user.terms;
  }
  return responses.success(res, 'user get')(user);
};

/**
 * @desc Public one-click unsubscribe endpoint (#4162, RFC 8058). No auth —
 * the token itself (verified via HMAC, see unsubscribeToken.js) IS the
 * authorization, so a mail client's automated one-click POST works with no
 * session and no page. Responds the same way (200/400) whether the token was
 * tampered with, expired in format, or simply never existed — nothing here
 * lets a caller distinguish those cases — barring an unexpected server error
 * (422).
 * @param {Object} req - Express request object (req.params.token)
 * @param {Object} res - Express response object
 */
const unsubscribe = async (req, res) => {
  try {
    const parsed = verifyUnsubscribeToken(req.params.token);
    if (!parsed) return responses.error(res, 400, 'Bad Request', 'Unsubscribe token is invalid.')();

    const result = await UserService.setEmailPreference(parsed.userId, parsed.kind, false);
    if (!result) return responses.error(res, 400, 'Bad Request', 'Unsubscribe token is invalid.')();

    return responses.success(res, 'Unsubscribed successfully')({ kind: parsed.kind });
  } catch (err) {
    return responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to get stats of users and return data
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const stats = async (req, res) => {
  const data = await UserService.stats();
  if (!data.err) {
    responses.success(res, 'users stats')(data);
  } else {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(data.err))(data.err);
  }
};

export default {
  update,
  terms,
  remove,
  me,
  stats,
  unsubscribe,
};
