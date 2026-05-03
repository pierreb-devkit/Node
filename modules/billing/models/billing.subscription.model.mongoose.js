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

    // ── Meter fields (sparse — backward-compatible additions) ────────────────

    /**
     * The plan version active on this subscription (e.g. "v1", "v2").
     * Only populated when meterMode is enabled.
     */
    planVersion: {
      type: String,
      sparse: true,
    },
    /**
     * Start of the current billing period. Used to detect period changes
     * in webhook handlers and trigger meter period resets.
     */
    currentPeriodStart: {
      type: Date,
      default: null,
    },
    /**
     * Timestamp when the subscription first entered past_due status.
     * Used to enforce the 7-day grace period before degraded mode.
     */
    pastDueSince: {
      type: Date,
      default: null,
    },
    /**
     * Timestamp of the last successful weekly meter reset sweep.
     * Used by the scheduler to recover after delayed or missed runs.
     */
    lastResetAt: {
      type: Date,
      default: null,
    },
    /**
     * Stripe event.created timestamp (Unix seconds) of the last processed subscription event.
     * Used to guard webhook handlers against out-of-order delivery — older events are skipped.
     */
    stripeEventCreatedAt: {
      type: Number,
      default: null,
    },
    /**
     * Stripe event.id of the last processed subscription event.
     * Tiebreaker for same-second events (lex string ordering on evt_ IDs).
     */
    stripeEventId: {
      type: String,
      default: null,
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
