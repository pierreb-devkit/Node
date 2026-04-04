/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Supported webhook event types
 */
const WEBHOOK_EVENTS = ['scrap.success', 'scrap.failure', 'scrap.created', 'scrap.deleted'];

/**
 * Data Model Mongoose
 */
const WebhookMongoose = new Schema(
  {
    url: {
      type: String,
      required: true,
      trim: true,
    },
    events: {
      type: [String],
      required: true,
      enum: WEBHOOK_EVENTS,
    },
    secret: {
      type: String,
      required: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
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
WebhookMongoose.virtual('id').get(addID);
// Ensure virtual fields are serialised — strip secret from API responses.
WebhookMongoose.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.secret;
    return ret;
  },
});

mongoose.model('Webhook', WebhookMongoose);
