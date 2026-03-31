/**
 * Module dependencies
 */
import jwt from 'jsonwebtoken';

import AuthService from '../services/auth.service.js';
import UserService from '../../users/services/users.service.js';
import mails from '../../../lib/helpers/mailer/index.js';
import getBaseUrl from '../../../lib/helpers/getBaseUrl.js';
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';

const tokenCookieOptions = {
  httpOnly: true,
  secure: config.cookie.secure,
  sameSite: config.cookie.sameSite,
};

/**
 * @desc Endpoint to init password reset mail
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends a JSON response with reset status.
 */
const forgot = async (req, res) => {
  let user;
  // check input
  if (!req.body.email) return responses.error(res, 422, 'Unprocessable Entity', 'Mail field must not be blank')();
  const email = String(req.body.email);
  // get user generate and add token
  try {
    user = await UserService.getBrut({ email });
    if (!user) return responses.error(res, 400, 'Bad Request', 'No account with that email has been found')();
    if (user.provider !== 'local')
      return responses.error(res, 400, 'Bad Request', `It seems like you signed up using your ${user.provider} account`)();
    const edit = {
      resetPasswordToken: jwt.sign({ exp: Date.now() + 3600000 }, config.jwt.secret, { algorithm: 'HS256' }),
      resetPasswordExpires: Date.now() + 3600000,
    };
    user = await UserService.update(user, edit, 'recover');
  } catch (err) {
    return responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
  // send mail
  try {
    const mail = await mails.sendMail({
      template: 'reset-password-email',
      to: user.email,
      subject: 'Password Reset',
      params: {
        displayName: [user.firstName, user.lastName].filter(Boolean).join(' '),
        url: `${getBaseUrl()}/reset?token=${user.resetPasswordToken}`,
        appName: config.app.title,
        appContact: config.app.contact,
      },
    });
    if (!mail || !mail.accepted) return responses.error(res, 400, 'Bad Request', 'Failure sending email')();
    return responses.success(res, 'An email has been sent with further instructions')({ status: true });
  } catch (_mailErr) {
    return responses.error(res, 400, 'Bad Request', 'Failure sending email')();
  }
};

/**
 * @desc Endpoint to validate Reset Token from link
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const validateResetToken = async (req, res) => {
  try {
    const user = await UserService.getBrut({ resetPasswordToken: String(req.params.token) });
    if (!user || !user.email) return res.redirect('/api/password/reset/invalid');
    res.redirect(`/api/password/reset/${req.params.token}`);
  } catch (_err) {
    return res.redirect('/api/password/reset/invalid');
  }
};

/**
 * @desc Endpoint to reset password from url with token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>} Sends a JSON response with the updated user and token.
 */
const reset = async (req, res) => {
  let user;
  // check input
  if (!req.body.token || !req.body.newPassword) return responses.error(res, 400, 'Bad Request', 'Password or Token fields must not be blank')();
  const token = String(req.body.token);
  // get user by token, update with new password, login again
  try {
    user = await UserService.getBrut({ resetPasswordToken: token });
    if (!user || !user.email) return responses.error(res, 400, 'Bad Request', 'Password reset token is invalid or has expired.')();
    const edit = {
      password: await AuthService.hashPassword(req.body.newPassword),
      resetPasswordToken: null,
      resetPasswordExpires: null,
    };
    user = await UserService.update(user, edit, 'recover');
    // send confirmation mail (fire-and-forget)
    mails.sendMail({
      template: 'reset-password-confirm-email',
      to: user.email,
      subject: 'Your password has been changed',
      params: {
        displayName: [user.firstName, user.lastName].filter(Boolean).join(' '),
        appName: config.app.title,
        appContact: config.app.contact,
      },
    }).catch((err) => logger.warn('auth.password.reset: confirmation email failed', err));
    return res
      .status(200)
      .cookie('TOKEN', jwt.sign({ userId: user.id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn }), tokenCookieOptions)
      .json({
        user,
        tokenExpiresIn: Date.now() + config.jwt.expiresIn * 1000,
        type: 'sucess',
        message: 'Password changed successfully',
      });
  } catch (err) {
    return responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * Change Password
 */
const updatePassword = async (req, res) => {
  let user;
  let password;
  // check input
  if (!req.body.newPassword) return responses.error(res, 400, 'Bad Request', 'Please provide a new password')();
  // get user, check password, update user, login again
  try {
    user = await UserService.getBrut({ id: req.user.id });
    if (!user || !user.email) return responses.error(res, 400, 'Bad Request', 'User is not found')();
    if (!(await AuthService.comparePassword(req.body.currentPassword, user.password)))
      return responses.error(res, 422, 'Unprocessable Entity', 'Current password is incorrect')();
    if (req.body.newPassword !== req.body.verifyPassword) return responses.error(res, 422, 'Unprocessable Entity', 'Passwords do not match')();
    password = AuthService.checkPassword(req.body.newPassword);
    user = await UserService.update(user, { password }, 'recover');
    return res
      .status(200)
      .cookie('TOKEN', jwt.sign({ userId: user.id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn }), tokenCookieOptions)
      .json({
        user,
        tokenExpiresIn: Date.now() + config.jwt.expiresIn * 1000,
        type: 'sucess',
        message: 'Password changed successfully',
      });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

export default {
  forgot,
  validateResetToken,
  reset,
  updatePassword,
};
