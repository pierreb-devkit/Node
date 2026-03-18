/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Data Model Mongoose
 */
const UsageMongoose = new Schema(
  {
    organizationId: {
      type: Schema.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    month: {
      type: String,
      required: true,
      index: true,
    },
    counters: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  },
);

UsageMongoose.index({ organizationId: 1, month: 1 }, { unique: true });

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
UsageMongoose.virtual('id').get(addID);
// Ensure virtual fields are serialised.
UsageMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('BillingUsage', UsageMongoose);
