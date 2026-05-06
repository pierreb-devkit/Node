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
    /**
     * Number of handler execution attempts (including failed ones).
     * Incremented on each handler exception before deciding to rollback or dead-letter.
     */
    attempts: {
      type: Number,
      default: 0,
    },
    /**
     * Last handler error message — set when the handler throws.
     */
    lastError: {
      type: String,
      default: null,
    },
    /**
     * Timestamp of the last handler error.
     */
    lastErrorAt: {
      type: Date,
      default: null,
    },
    /**
     * When true, the event has exceeded max retry attempts.
     * The claim is kept permanently so Stripe stops retrying.
     */
    deadLetter: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: false,
    // Disable _id virtuals to keep the document lean
  },
);

/**
 * TTL index: automatically remove documents 30 days after processedAt.
 *
 * Excludes dead-letter documents via partial filter: dead-lettered events are
 * permanent rejections (Stripe was told to stop retrying via 200 response) and
 * must NEVER be purged. If purged, a manual replay from the Stripe dashboard
 * after 30 days would re-process the event as if new — causing potential
 * double-credit on extras packs or double subscription resets.
 */
ProcessedStripeEventMongoose.index(
  { processedAt: 1 },
  {
    expireAfterSeconds: 30 * 24 * 60 * 60,
    partialFilterExpression: { deadLetter: { $eq: false } },
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
ProcessedStripeEventMongoose.virtual('id').get(addID);
ProcessedStripeEventMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('ProcessedStripeEvent', ProcessedStripeEventMongoose);
