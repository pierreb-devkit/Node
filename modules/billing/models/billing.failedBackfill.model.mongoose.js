/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * BillingFailedBackfill Data Model Mongoose
 *
 * Dead-letter store for PaymentIntent metadata backfill failures.
 * Records are written when the refund-correlation backfill (stripe.paymentIntents.update
 * in handleCheckoutPaymentCompleted) fails after all retry attempts.
 *
 * Kept permanently so operators can manually reconcile unresolved entries.
 * Never auto-expired — resolvedAt is set by the operator after manual fix.
 */
const BillingFailedBackfillMongoose = new Schema(
  {
    paymentIntentId: {
      type: String,
      required: true,
      index: true,
    },
    stripeSessionId: {
      type: String,
      required: true,
    },
    /**
     * Serialised error message from the last failed attempt.
     */
    error: {
      type: String,
      default: null,
    },
    /**
     * Timestamp of the first failure (when the record was created).
     */
    failedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    /**
     * Timestamp set by the operator after the PI metadata has been manually patched
     * and the refund correlation risk resolved.
     */
    resolvedAt: {
      type: Date,
      default: null,
    },
    /**
     * Operator tag explaining how the record was resolved.
     * E.g. 'admin', 'cron'.
     */
    resolvedBy: {
      type: String,
      default: null,
    },
  },
  {
    collection: 'billing_failed_backfills',
    timestamps: false,
  },
);

// Partial index — only unresolved documents are indexed, so this stays small
// even after the collection accumulates many resolved entries.
// (Sparse would be a no-op here: resolvedAt has default: null, so every document
// has the field present — sparse skips only docs where the field is absent.)
BillingFailedBackfillMongoose.index(
  { resolvedAt: 1 },
  { partialFilterExpression: { resolvedAt: null } },
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
BillingFailedBackfillMongoose.virtual('id').get(addID);
BillingFailedBackfillMongoose.set('toJSON', {
  virtuals: true,
});

export const BillingFailedBackfill =
  mongoose.models.BillingFailedBackfill ??
  mongoose.model('BillingFailedBackfill', BillingFailedBackfillMongoose);
