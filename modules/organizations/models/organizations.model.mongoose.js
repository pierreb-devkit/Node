/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Data Model Mongoose
 */
const OrganizationMongoose = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
    },
    domain: {
      type: String,
      default: '',
    },
    plan: {
      type: String,
      enum: ['free', 'starter', 'pro', 'enterprise'],
      default: 'free',
    },
    createdBy: {
      type: Schema.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  },
);

/**
 * @desc Function to add id (+ _id) to all objects
 * @return {String} hex string of the ObjectId
 */
function addID() {
  return this._id.toHexString();
}

/**
 * Model configuration
 */
OrganizationMongoose.virtual('id').get(addID);
// Ensure virtual fields are serialised.
OrganizationMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('Organization', OrganizationMongoose);
