/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Data Model Mongoose
 */
const ApiKeyMongoose = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    hashedKey: {
      type: String,
      required: true,
    },
    prefix: {
      type: String,
      required: true,
      index: true,
    },
    scopes: {
      type: [String],
      default: ['read'],
      enum: ['read', 'write'],
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    revoked: {
      type: Boolean,
      default: false,
    },
    user: {
      type: Schema.ObjectId,
      ref: 'User',
      required: true,
    },
    organizationId: {
      type: Schema.ObjectId,
      ref: 'Organization',
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Returns the hex string representation of the document ObjectId.
 * @returns {string} Hex string of the ObjectId.
 */
function addID() {
  return this._id.toHexString();
}

/**
 * Model configuration
 */
ApiKeyMongoose.virtual('id').get(addID);
// Ensure virtual fields are serialised — strip hashedKey from API responses.
ApiKeyMongoose.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.hashedKey;
    return ret;
  },
});

/**
 * Index for fast lookup by hashedKey during authentication.
 */
ApiKeyMongoose.index({ hashedKey: 1 });

mongoose.model('ApiKey', ApiKeyMongoose);
