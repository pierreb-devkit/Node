/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Data Model Mongoose
 */
const WebhookDeliveryMongoose = new Schema(
  {
    webhook: {
      type: Schema.ObjectId,
      ref: 'Webhook',
      required: true,
    },
    event: {
      type: String,
      required: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      default: {},
    },
    statusCode: {
      type: Number,
      default: null,
    },
    responseBody: {
      type: String,
      default: null,
    },
    duration: {
      type: Number,
      default: null,
    },
    success: {
      type: Boolean,
      default: false,
    },
    attempts: {
      type: Number,
      default: 1,
    },
    nextRetryAt: {
      type: Date,
      default: null,
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
WebhookDeliveryMongoose.virtual('id').get(addID);
// Ensure virtual fields are serialised.
WebhookDeliveryMongoose.set('toJSON', {
  virtuals: true,
});

/**
 * Compound index for retry queries: find failed deliveries due for retry.
 */
WebhookDeliveryMongoose.index({ success: 1, nextRetryAt: 1, attempts: 1 });

mongoose.model('WebhookDelivery', WebhookDeliveryMongoose);
