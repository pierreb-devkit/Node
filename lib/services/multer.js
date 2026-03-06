/**
 * Module dependencies.
 */
import _ from 'lodash';
import multer from 'multer';
import gridfsService from './gridfs.js';

// import AppError from '../helpers/AppError.js';

/**
 * @desc File filter
 * @param {Array} formats - array of accepted mimetype string
 * @return {callback}
 */
const fileFilter = (formats, size) => (req, file, cb) => {
  const fileSize = parseInt(req.headers['content-length'], 10);
  if (fileSize > size) return cb(new Error(`Only files lower than ${size / (1024 * 1024)}mo are allowed`, { code: 'SERVICE_ERROR' }), false);
  if (!formats.includes(file.mimetype)) return cb(new Error(`Only ${formats} files allowed`, { code: 'SERVICE_ERROR' }), false);
  return cb(null, true);
};

/**
 * @desc file upload middleware
 * @param {String} name - key data name in form-data
 * @param {Object} config - multer config
 * @return {callback}
 */
const create = (config) => async (req, res, next) => {
  // condif
  const options = _.cloneDeep(config) || {};
  if (options.formats) {
    options.fileFilter = fileFilter(options.formats, options.limits.fileSize);
    delete options.formats;
  }
  options.storage = gridfsService.getStorage();
  // kind
  req.kind = config.kind;
  // upload
  const upload = multer(options).single('img');
  upload(req, res, (err) => {
    if (err) {
      req.multerErr = err;
    }
    next();
  });
};

export default {
  create,
};
