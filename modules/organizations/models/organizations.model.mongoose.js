/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import config from '../../../config/index.js';

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
    description: {
      type: String,
      default: '',
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
      trim: true,
      lowercase: true,
    },
    plan: {
      type: String,
      enum: config.billing.plans,
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
