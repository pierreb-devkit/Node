/**
 * Module dependencies
 */
import sharp from 'sharp';
import _ from 'lodash';

import config from '../../../config/index.js';
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import UploadsService from '../services/uploads.service.js';

/**
 * Allowlisted MIME types for private download (get).
 * Defense-in-depth: prevents stored-XSS when a downstream kind permits a dangerous MIME.
 */
const SAFE_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

/**
 * Allowlisted MIME types for public image serving (getSharp).
 * Restricted to image types — the sharp pipeline only handles images.
 */
const SAFE_IMAGE_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);

/**
 * @desc Endpoint to get an upload by fileName
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const get = async (req, res) => {
  try {
    const stream = await UploadsService.getStream({ _id: req.upload._id });
    if (!stream) responses.error(res, 404, 'Not Found', 'No Upload with that identifier can been found')();
    stream.on('error', (err) => {
      responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
    });
    const raw = req.upload.contentType || req.upload.metadata?.contentType || 'application/octet-stream';
    const contentType = SAFE_MIME.has(raw) ? raw : 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', 'attachment');
    if (req.upload.length) res.set('Content-Length', req.upload.length);
    stream.pipe(res);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to get an upload by fileName with sharp options
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getSharp = async (req, res) => {
  try {
    const stream = await UploadsService.getStream({ _id: req.upload._id });
    if (!stream) responses.error(res, 404, 'Not Found', 'No Upload with that identifier can been found')();
    stream.on('error', (err) => {
      responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
    });
    const raw = req.upload.contentType || req.upload.metadata?.contentType || 'application/octet-stream';
    const contentType = SAFE_IMAGE_MIME.has(raw) ? raw : 'image/jpeg';
    res.set('Content-Type', contentType);
    switch (req.sharpOption) {
      case 'blur':
        stream.pipe(sharp().resize(req.sharpSize).blur(config.uploads.sharp.blur)).pipe(res);
        break;
      case 'bw':
        stream.pipe(sharp().resize(req.sharpSize).grayscale()).pipe(res);
        break;
      case 'blur&bw':
        stream.pipe(sharp().resize(req.sharpSize).grayscale().blur(config.uploads.sharp.blur)).pipe(res);
        break;
      default:
        stream.pipe(sharp().resize(req.sharpSize)).pipe(res);
    }
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to remove an upload
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const remove = async (req, res) => {
  try {
    await UploadsService.remove({ _id: req.upload._id });
    responses.success(res, 'upload deleted')();
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc MiddleWare to ask the service the uppload for this uploadName
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @param {String} filename - upload filename
 */
const uploadByName = async (req, res, next, uploadName) => {
  try {
    const upload = await UploadsService.get(uploadName);
    if (!upload) responses.error(res, 404, 'Not Found', 'No Upload with that name has been found')();
    else {
      req.upload = upload;
      next();
    }
  } catch (err) {
    next(err);
  }
};

/**
 * @desc MiddleWare to ask the service the uppload for this uploadImageName
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @param {String} filename & params - upload filename & eventual params (two max) filename-maxSize-options.png
 */
const uploadByImageName = async (req, res, next, uploadImageName) => {
  try {
    // Name
    const imageName = uploadImageName.split('.');
    const opts = imageName[0].split('-');
    if (imageName.length !== 2) return responses.error(res, 404, 'Not Found', 'Wrong name schema')();
    if (opts.length > 3) return responses.error(res, 404, 'Not Found', 'Too much params')();

    // data work
    const upload = await UploadsService.get(`${opts[0]}.${imageName[1]}`);
    if (!upload) return responses.error(res, 404, 'Not Found', 'No Upload with that name has been found')();

    // options
    const sharp = _.get(config, `uploads.${upload.metadata.kind}.sharp`);
    if (opts[1] && (!sharp || !sharp.sizes)) return responses.error(res, 422, 'Unprocessable Entity', 'Size param not available')();
    if (opts[1] && (!/^\d+$/.test(opts[1]) || !sharp.sizes.includes(opts[1])))
      return responses.error(res, 422, 'Unprocessable Entity', 'Wrong size param')();
    if (opts[2] && (!sharp || !sharp.operations)) return responses.error(res, 422, 'Unprocessable Entity', 'Operations param not available')();
    if (opts[2] && !sharp.operations.includes(opts[2])) return responses.error(res, 422, 'Unprocessable Entity', 'Operation param not available')();

    // return
    req.upload = upload;
    req.sharpSize = parseInt(opts[1], 10) || null;
    req.sharpOption = opts[2] || null;
    next();
  } catch (err) {
    next(err);
  }
};

export default {
  get,
  getSharp,
  remove,
  uploadByName,
  uploadByImageName,
};
