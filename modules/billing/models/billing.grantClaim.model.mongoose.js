/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * BillingGrantClaim Data Model Mongoose
 *
 * Durable, database-enforced claim on a BillingExtraBalanceRepository.creditGrant
 * idempotencyKey (#4155). The ledger (`modules/billing/models/billing.extraBalance.model.mongoose.js`)
 * is an embedded array per organization — a unique index on it cannot enforce uniqueness
 * ACROSS organizations without a migration against already-deployed data. This is a
 * separate, brand-new collection instead: the unique index on `key` is built fresh (no
 * pre-existing data, no migration), and MongoDB enforces it permanently — unlike a
 * TTL/lease-based lock, there is no window where an expired holder can still write.
 *
 * The claim is never deleted or expired. `organization` records who claimed it, so a
 * later call with the SAME key can tell "my own retry/replay after a crash" (same org —
 * fall through to the ordinary per-org ledger guard, which is idempotent on its own) from
 * "a different org already holds this key" (the cross-org double-grant this exists to
 * prevent — rejected as a duplicate).
 */
const GrantClaimMongoose = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    organization: {
      type: Schema.ObjectId,
      ref: 'Organization',
      required: true,
    },
    at: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
  },
  {
    timestamps: false,
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
GrantClaimMongoose.virtual('id').get(addID);
GrantClaimMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('BillingGrantClaim', GrantClaimMongoose);
