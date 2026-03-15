/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import mails from '../../../lib/helpers/mailer/index.js';
import config from '../../../config/index.js';
import UserService from '../services/users.service.js';
import TaskDataService from '../../tasks/services/tasks.data.service.js';
import UploadDataService from '../../uploads/services/uploads.data.service.js';

/**
 * @desc Endpoint to ask the service to remove the user connected and all his data
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const remove = async (req, res) => {
  try {
    const result = {
      user: await UserService.remove(req.user),
      tasks: await TaskDataService.remove(req.user),
      uploads: await UploadDataService.remove(req.user),
    };
    responses.success(res, 'user and his data were deleted')({ id: req.user.id, ...result });
  } catch (err) {
    console.log('err', err);
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to ask the service to get all user data
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const get = async (req, res) => {
  try {
    const result = {
      user: await UserService.get(req.user),
      tasks: await TaskDataService.list(req.user),
      uploads: await UploadDataService.list(req.user),
    };
    responses.success(res, 'user data')(result);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to ask the service to get all user data and send it to user mail
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getMail = async (req, res) => {
  try {
    const result = {
      user: await UserService.get(req.user),
      tasks: await TaskDataService.list(req.user),
      uploads: await UploadDataService.list(req.user),
    };

    // send mail
    const mail = await mails.sendMail({
      template: 'data-privacy-email',
      to: req.user.email,
      subject: `${config.app.title}: your data`,
      params: {
        result: JSON.stringify(result),
        displayName: [req.user.firstName, req.user.lastName].filter(Boolean).join(' '),
        appName: config.app.title,
        appContact: config.app.contact,
      },
    });

    if (!mail || !mail.accepted) return responses.error(res, 400, 'Bad Request', 'Failure sending email')();
    responses.success(res, 'An email has been sent to the user email with data')({ status: true });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

export default {
  remove,
  get,
  getMail,
};
