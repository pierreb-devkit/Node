/**
 * Module dependencies
 */
import sharp from 'sharp';
import _ from 'lodash';

import config from '../../../config/index.js';
import errors from '../../../lib/helpers/errors.js';
import logger from '../../../lib/services/logger.js';
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
 * Normalize a raw Content-Type value for safe allowlist comparison.
 * MIME types are case-insensitive and may include parameters (e.g. `image/jpeg; charset=binary`).
 * Strip any `;` parameter segment, lowercase, and trim before checking the allowlist.
 * @param {string} raw - Raw content-type string.
 * @returns {string} Normalized MIME type (e.g. `image/jpeg`).
 */
const normalizeMime = (raw) => String(raw).toLowerCase().split(';')[0].trim();

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
      // Guard against ERR_HTTP_HEADERS_SENT when GridFS fails mid-transfer:
      // `res.set('Content-Type', ...)` below flushes response headers to the
      // client before the stream starts. If the GridFS read then errors, a
      // second status+body write would throw ERR_HTTP_HEADERS_SENT and crash
      // the worker process. Pre-header errors still reach the client as 422;
      // post-header errors destroy the socket so Express surfaces them via
      // its default error handler instead of double-sending.
      if (!res.headersSent) {
        responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
      } else {
        logger.error('uploads.get - stream error after headers sent', err);
        res.destroy(err);
      }
    });
    const raw = req.upload.contentType || req.upload.metadata?.contentType || 'application/octet-stream';
    const norm = normalizeMime(raw);
    const contentType = SAFE_MIME.has(norm) ? norm : 'application/octet-stream';
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
 * @returns {Promise<void>} Resolves when the image stream has been piped to the response.
 */
const getSharp = async (req, res) => {
  try {
    const stream = await UploadsService.getStream({ _id: req.upload._id });
    if (!stream) responses.error(res, 404, 'Not Found', 'No Upload with that identifier can been found')();
    stream.on('error', (err) => {
      // Same headersSent guard as `get` above. A sharp pipeline error after
      // `res.set('Content-Type', ...)` has flushed the response head cannot
      // write a new status or body — attempting to do so throws
      // ERR_HTTP_HEADERS_SENT. Destroy the socket instead so Express surfaces
      // the error via its default handler without double-sending.
      if (!res.headersSent) {
        responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
      } else {
        logger.error('uploads.getSharp - stream error after headers sent', err);
        res.destroy(err);
      }
    });
    const raw = req.upload.contentType || req.upload.metadata?.contentType || 'application/octet-stream';
    const norm = normalizeMime(raw);
    const contentType = SAFE_IMAGE_MIME.has(norm) ? norm : 'image/jpeg';
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
