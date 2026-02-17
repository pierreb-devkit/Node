import path from 'path';
import crypto from 'crypto';
import mongoose from 'mongoose';

let storage;

class GridFsStorage {
  constructor() {
    this.bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
  }

  _handleFile(req, file, cb) {
    const metadata = {
      user: req.user.id ? new mongoose.Types.ObjectId(req.user.id) : null,
      kind: req.kind ? req.kind : null,
      contentType: file.mimetype,
    };
    const filename = `${crypto.randomBytes(32).toString('hex')}${path.extname(file.originalname)}`;
    const options = {
      metadata,
      contentType: file.mimetype,
    };

    const uploadStream = this.bucket.openUploadStreamWithId(new mongoose.Types.ObjectId(), filename, options);

    file.stream.pipe(
      uploadStream.on('error', cb).on('finish', () => {
        cb(null, {
          filename,
          metadata,
          bucketName: 'uploads',
        });
      }),
    );
  }

  _removeFile(req, file, cb) {
    this.bucket.delete(file.id, cb);
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

export default {
  getStorage,
};
