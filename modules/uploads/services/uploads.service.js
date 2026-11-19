/**
 * Module dependencies
 */
import crypto from 'crypto';

import config from '../../../config/index.js';
import AppError from '../../../lib/helpers/AppError.js';
import { isObjectId } from '../../../lib/helpers/zod.js';
import gridfs from '../repositories/uploads.gridfs.repository.js';
import UploadRepository from '../repositories/uploads.repository.js';

const MIME_TO_EXT = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  // Allows downstream features that store rendered HTML snapshots in GridFS
  // alongside binary uploads (e.g. error pages, document previews).
  'text/html': 'html',
};

/**
 * @desc Function to ask repository to get an upload
 * @param {String} uploadName
 * @return {Promise} Upload
 */
const get = async (uploadName) => UploadRepository.get(uploadName);

/**
 * @desc Function to ask repository to get stream of chunks data
 * @param {Object} upload - an Upload doc (with `_id`)
 * @return {Promise} result stream
 */
const getStream = async (upload) => UploadRepository.getStream(upload);

/**
 * @desc Function to ask repository to remove chunks data
 * @param {Object} upload - an Upload doc, or a bare lookup key (e.g. `{ filename }`)
 * @return {Promise} confirmation of delete
 */
const remove = async (upload) => UploadRepository.remove(upload);

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

/**
 * @desc Delete every upload scoped to one organization, stored files included
 * (org-removal cleanup). Uploads with no organization (e.g. user avatars) are
 * never touched: an invalid id throws before any lookup, so a missing id can
 * never widen the match.
 * @param {String} organizationId - the removed organization's ObjectId
 * @return {Promise<{deleted: Number}>} number of files removed
 * @throws {AppError} when organizationId is not a valid ObjectId
 */
const removeByOrganization = async (organizationId) => {
  if (!isObjectId(organizationId)) {
    throw new AppError('Upload: invalid organization id for removal cleanup', { code: 'SERVICE_ERROR' });
  }
  return UploadRepository.removeByOrganization(String(organizationId));
};

export default {
  get,
  getStream,
  remove,
  createFromBuffer,
  removeByOrganization,
};
