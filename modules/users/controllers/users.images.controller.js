/**
 * Module dependencies
 */
import AppError from '../../../lib/helpers/AppError.js';
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import UploadsService from '../../uploads/services/uploads.service.js';
import UserService from '../services/users.service.js';

/**
 * @desc Delete the user's current avatar file, but only when that stored
 *   upload belongs to the user (`metadata.user`). A file owned by anyone else
 *   is left untouched; the user's `avatar` field is still reset by the caller.
 * @param {Object} user - the authenticated user (`req.user`)
 * @returns {Promise<void>}
 */
const removeOwnAvatarFile = async (user) => {
  if (!user?.avatar) return;
  const upload = await UploadsService.get(user.avatar);
  if (!upload) return;
  if (!upload.metadata?.user) return;
  if (String(upload.metadata.user) !== String(user._id)) return;
  await UploadsService.remove(upload);
};

/**
 * @desc Endpoint to ask the service to update a user profile avatar
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>} resolves once the response has been sent; the
 *   success path replies from inside `req.login`'s callback, so nothing is
 *   returned to the caller.
 */
const updateAvatar = async (req, res) => {
  try {
    // catch multerErr — curated to `{ message }` only (issue #4059, ninth site:
    // a raw Multer error was forwarded wholesale, the identical anti-pattern the
    // other eight call sites were fixed for). Multer attaches its own `code`
    // (e.g. `LIMIT_FILE_SIZE`) and `field` on top of `message`; only `message`
    // is a deliberate, human-readable reason worth publishing.
    if (req.multerErr) throw new AppError(req.multerErr.message, { status: 422, code: 'SERVICE_ERROR', details: { message: req.multerErr.message } });
    // delete old image (only if it belongs to this user)
    await removeOwnAvatarFile(req.user);
    // update user
    const user = await UserService.update(req.user, { avatar: req.file.filename });
    // reload playload
    req.login(user, { session: false }, (errLogin) => {
      if (errLogin) return responses.error(res, 400, 'Bad Request', errors.getMessage(errLogin))(errLogin);
      return responses.success(res, 'profile avatar updated')(user);
    });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to ask the service to remove a user profile avatar
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>} resolves once the response has been sent; the
 *   success path replies from inside `req.login`'s callback, so nothing is
 *   returned to the caller.
 */
const removeAvatar = async (req, res) => {
  try {
    await removeOwnAvatarFile(req.user);
    // update user
    const user = await UserService.update(req.user, { avatar: '' });
    // reload playload
    req.login(user, { session: false }, (errLogin) => {
      if (errLogin) return responses.error(res, 400, 'Bad Request', errors.getMessage(errLogin))(errLogin);
      return responses.success(res, 'profile avatar updated')(user);
    });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

export default {
  updateAvatar,
  removeAvatar,
};
