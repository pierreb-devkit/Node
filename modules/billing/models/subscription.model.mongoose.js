/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import config from '../../../config/index.js';

const Schema = mongoose.Schema;

/**
 * Data Model Mongoose
 */
const SubscriptionMongoose = new Schema(
  {
    organization: {
      type: Schema.ObjectId,
      ref: 'Organization',
      unique: true,
      required: true,
    },
    stripeCustomerId: {
      type: String,
      unique: true,
      sparse: true,
    },
    stripeSubscriptionId: {
      type: String,
      unique: true,
      sparse: true,
    },
    plan: {
      type: String,
      enum: config.billing.plans,
      default: 'free',
    },
    status: {
      type: String,
      enum: config.billing.statuses,
      default: 'active',
    },
    currentPeriodEnd: {
      type: Date,
    },
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
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
SubscriptionMongoose.virtual('id').get(addID);
// Ensure virtual fields are serialised.
SubscriptionMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('Subscription', SubscriptionMongoose);
