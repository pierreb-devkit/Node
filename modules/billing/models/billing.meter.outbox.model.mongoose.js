/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Meter outbox model.
 *
 * Stores deferred extras debits created after meter usage crosses plan quota.
 * Pending rows are retried by the billing retry-pending-extras-debit cron.
 */
const BillingMeterOutboxMongoose = new Schema({
  organizationId: { type: Schema.ObjectId, required: true, index: true },
  idempotencyKey: { type: String, required: true, unique: true },
  extrasUnits: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'committed', 'failed'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  lastAttemptedAt: { type: Date, default: null },
  createdAt: { type: Date, default: () => new Date() },
});

BillingMeterOutboxMongoose.index({ status: 1, lastAttemptedAt: 1 });

/**
 * Returns the hex string representation of the document ObjectId.
 * @returns {string} Hex string of the ObjectId.
 */
function addID() {
  return this._id.toHexString();
}

BillingMeterOutboxMongoose.virtual('id').get(addID);
BillingMeterOutboxMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('BillingMeterOutbox', BillingMeterOutboxMongoose);
