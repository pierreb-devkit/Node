/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Data Model Mongoose
 */
const UploadsMongoose = new Schema(
  {
    length: Number,
    chunkSize: Number,
    uploadDate: Date,
    md5: String,
    filename: String,
    contentType: String,
    metadata: {
      user: {
        type: Schema.ObjectId,
        ref: 'User',
      },
      organizationId: {
        type: Schema.ObjectId,
        ref: 'Organization',
      },
      kind: String,
    },
  },
  { strict: false },
);

mongoose.model('Uploads', UploadsMongoose, 'uploads.files');
mongoose.model('UploadsChunks', new Schema(), 'uploads.chunks');
