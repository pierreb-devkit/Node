import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import mongoose from 'mongoose';

let storage;

class GridFsStorage {
  constructor() {
    this.bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
  }

  /**
   * Store an incoming file in GridFS.
   * @param {object} req - express request object
   * @param {object} file - multer file descriptor
   * @param {(error: Error | null, info?: object) => void} cb - callback(error, info)
   */
  _handleFile(req, file, cb) {
    const metadata = {
      user: req.user?.id ? new mongoose.Types.ObjectId(req.user.id) : null,
      kind: req.kind ? req.kind : null,
      contentType: file.mimetype,
    };
    const filename = `${crypto.randomBytes(32).toString('hex')}${path.extname(file.originalname)}`;
    const options = {
      metadata,
    };

    const uploadStream = this.bucket.openUploadStreamWithId(new mongoose.Types.ObjectId(), filename, options);

    file.stream.pipe(
      uploadStream.on('error', cb).on('finish', () => {
        cb(null, {
          id: uploadStream.id,
          filename,
          metadata,
          bucketName: 'uploads',
        });
      }),
    );
  }

  /**
   * Remove a file from GridFS.
   * @param {object} req - express request object
   * @param {object} file - multer file descriptor with id
   * @param {(error: Error | null) => void} cb - callback(error)
   */
  _removeFile(req, file, cb) {
    // The driver's `delete(id, options)` returns a promise and never calls a
    // callback: settle multer's `cb` from the promise, or the request hangs.
    this.bucket.delete(file.id).then(() => cb(null), cb);
  }
}

/**
 * Init multer storage
 */
const getStorage = () => {
  if (!storage) {
    storage = new GridFsStorage();
  }
  return storage;
};

/**
 * Store a buffer in GridFS programmatically (no HTTP upload).
 * @param {Buffer} buffer - File content
 * @param {string} filename - Unique filename (e.g., 'snapshot-abc123.jpeg')
 * @param {string} contentType - MIME type (e.g., 'image/jpeg'), stored as `metadata.contentType`
 * @param {Object} metadata - GridFS metadata (kind, user, organizationId, etc.)
 * @returns {Promise<Object>} The stored file document
 */
const createFromBuffer = (buffer, filename, contentType, metadata = {}) => new Promise((resolve, reject) => {
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
  const id = new mongoose.Types.ObjectId();
  const uploadStream = bucket.openUploadStreamWithId(id, filename, { metadata: { ...metadata, contentType } });

  const readable = Readable.from([buffer]);
  readable.on('error', reject);
  readable.pipe(
    uploadStream
      .on('error', reject)
      .on('finish', async () => {
        try {
          const Uploads = mongoose.model('Uploads');
          const file = await Uploads.findOne({ _id: id }).exec();
          resolve(file);
        } catch (err) {
          reject(err);
        }
      }),
  );
});

export default {
  getStorage,
  createFromBuffer,
};
