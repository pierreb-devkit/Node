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
    // ── Per-family event ordering guards ─────────────────────────────────────
    // Separate trackers for 'subscription' vs 'invoice' event families prevent
    // same-second cross-family deliveries from cancelling each other's state.

    /**
     * Stripe event.created (Unix seconds) of the last processed customer.subscription.* event.
     */
    lastSubscriptionEventCreatedAt: {
      type: Number,
      default: null,
    },
    /**
     * Stripe event.id of the last processed customer.subscription.* event (same-second tiebreaker).
     */
    lastSubscriptionEventId: {
      type: String,
      default: null,
    },
    /**
     * Stripe event.created (Unix seconds) of the last processed invoice.* event.
     */
    lastInvoiceEventCreatedAt: {
      type: Number,
      default: null,
    },
    /**
     * Stripe event.id of the last processed invoice.* event (same-second tiebreaker).
     */
    lastInvoiceEventId: {
      type: String,
      default: null,
    },

    // ── Admin override audit trail ───────────────────────────────────────────
    /**
     * Timestamp of the last admin-initiated plan change (via adminUpdatePlanOnly).
     * Distinct from updatedAt (touched by every webhook). Used by audit + ops UI to
     * surface when a subscription's plan was overridden manually.
     */
    adminUpdatedAt: {
      type: Date,
      default: null,
    },
    /**
     * ObjectId of the admin user who triggered the last plan override.
     */
    adminUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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
 * Compound indexes — scanning operations
 *
 * weeklyReset sweep: quickly find active/trialing subs whose lastResetAt is stale.
 * dunningSweep scan: quickly find past_due subs where pastDueSince has exceeded threshold.
 */
SubscriptionMongoose.index({ status: 1, lastResetAt: 1 });   // weeklyReset scan
SubscriptionMongoose.index({ status: 1, pastDueSince: 1 });  // dunningSweep scan

/**
 * Model configuration
 */
SubscriptionMongoose.virtual('id').get(addID);
// Ensure virtual fields are serialised.
SubscriptionMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('Subscription', SubscriptionMongoose);
