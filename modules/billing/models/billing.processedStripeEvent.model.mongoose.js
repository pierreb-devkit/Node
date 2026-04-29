/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * ProcessedStripeEvent Data Model Mongoose
 *
 * Idempotency store for Stripe webhook events.
 * TTL of 30 days — events older than that can safely be re-processed
 * (Stripe's webhook retry window is 3 days).
 */
const ProcessedStripeEventMongoose = new Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    type: {
      type: String,
      required: true,
      trim: true,
    },
    processedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
  },
  {
    timestamps: false,
    // Disable _id virtuals to keep the document lean
  },
);

/**
 * TTL index: automatically remove documents 30 days after processedAt
 */
ProcessedStripeEventMongoose.index({ processedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

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
ProcessedStripeEventMongoose.virtual('id').get(addID);
ProcessedStripeEventMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('ProcessedStripeEvent', ProcessedStripeEventMongoose);
