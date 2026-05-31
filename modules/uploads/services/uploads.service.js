/**
 * Module dependencies
 */
import crypto from 'crypto';

import config from '../../../config/index.js';
import AppError from '../../../lib/helpers/AppError.js';
import multerService from '../../../lib/services/multer.js';
import gridfs from '../../../lib/services/gridfs.js';
import UploadRepository from '../repositories/uploads.repository.js';

const MIME_TO_EXT = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  // Allows downstream features that store rendered HTML snapshots in GridFS
  // alongside binary uploads (e.g. error pages, scrap previews).
  'text/html': 'html',
};

/**
 * @desc Function to ask repository to get an upload
 * @param {String} uploadName
 * @return {Promise} Upload
 */
const get = async (uploadName) => {
  const result = await UploadRepository.get(uploadName);
  return Promise.resolve(result);
};

/**
 * @desc Function to ask repository to get stream of chunks data
 * @param {Object} Upload
 * @return {Promise} result stream
 */
const getStream = async (upload) => {
  const result = await UploadRepository.getStream(upload);
  return Promise.resolve(result);
};

/**
 * @desc Function to ask repository to update an upload
 * @param {Object} req.file
 * @param {Object} User
 * @param {String} kind, upload configuration path (important for futur transformations)
 * @return {Promise} Upload
 */
const update = async (file, user, kind) => {
  const update = {
    filename: await multerService.generateFileName(file.filename || file.originalname),
    metadata: {
      user: user.id,
      kind: kind || null,
    },
  };
  const result = await UploadRepository.update(file._id, update);
  return Promise.resolve(result);
};

/**
 * @desc Function to ask repository to remove chunks data
 * @param {Object} Upload
 * @return {Promise} confirmation of delete
 */
const remove = async (upload) => {
  const result = await UploadRepository.remove(upload);
  return Promise.resolve(result);
};

/**
 * @desc Store a buffer as an upload programmatically (no HTTP request)
 * @param {Buffer} buffer - File content
 * @param {string} contentType - MIME type (e.g., 'image/jpeg')
 * @param {string} kind - Upload kind matching config (e.g., 'snapshot')
 * @param {Object} metadata - Additional metadata (user, organizationId, etc.)
 * @returns {Promise<Object>} The created upload document
 */
const createFromBuffer = async (buffer, contentType, kind, metadata = {}) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new AppError('Upload: buffer is required and must be a Buffer', { code: 'SERVICE_ERROR', status: 422 });
  }

  const kindConfig = config.uploads?.[kind];
  if (!kindConfig) throw new AppError(`Upload: unknown kind "${kind}"`, { code: 'SERVICE_ERROR', status: 422 });

  if (!Array.isArray(kindConfig.formats)) {
    throw new AppError(`Upload: kind "${kind}" has no formats configured`, { code: 'SERVICE_ERROR', status: 500 });
  }

  if (!kindConfig.formats.includes(contentType)) {
    throw new AppError(`Upload: content type "${contentType}" not allowed for kind "${kind}"`, { code: 'SERVICE_ERROR', status: 422 });
  }

  if (kindConfig.limits?.fileSize && buffer.length > kindConfig.limits.fileSize) {
    throw new AppError(`Upload: buffer size ${buffer.length} exceeds limit ${kindConfig.limits.fileSize}`, { code: 'SERVICE_ERROR', status: 422 });
  }

  const rawExt = config.uploads?.mimeTypes?.[contentType] || MIME_TO_EXT[contentType];
  const ext = rawExt && /^[a-zA-Z0-9]+$/.test(rawExt) ? rawExt : 'bin';
  const filename = `${crypto.randomBytes(32).toString('hex')}.${ext}`;

  const result = await gridfs.createFromBuffer(buffer, filename, contentType, { ...metadata, kind, contentType });
  return result;
};

export default {
  get,
  getStream,
  update,
  remove,
  createFromBuffer,
};
