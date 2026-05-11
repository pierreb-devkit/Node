/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * ExtraBalance Data Model Mongoose
 *
 * Tracks prepaid "extra" meter units per organization.
 * Each org has at most one ExtraBalance document (unique on organization).
 *
 * The ledger array is an append-only audit trail of all balance mutations.
 * cachedBalance is kept in sync on every atomic write to avoid scanning
 * the entire ledger on hot-path reads.
 *
 * NOTE — Mixed type caveats (applies to embedded objects in subdocuments):
 *   Mongoose validators are NOT executed for in-place mutations on Mixed fields
 *   (doc.field.x = y; doc.save() silently skips validators).
 *   Always use atomic MongoDB operators ($inc, $push, $set via findOneAndUpdate)
 *   or Model.create() which runs validators on the full document.
 */
const LedgerEntrySchema = new Schema(
  {
    kind: {
      type: String,
      enum: ['topup', 'debit', 'refund', 'expiration', 'adjustment'],
      required: true,
    },
    /**
     * Signed amount in meter units.
     * Positive for topup/adjustment (add to balance).
     * Negative for debit/expiration/refund (subtract from balance).
     * Note: 'refund' entries are clawbacks and carry a negative amount,
     * reflecting the economic debt when credits already consumed must be reclaimed.
     */
    amount: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => v !== 0,
        message: 'Ledger entry amount cannot be zero',
      },
    },
    /**
     * Stripe checkout session ID — used for topup idempotency.
     * Only set for kind='topup'.
     */
    stripeSessionId: {
      type: String,
    },
    /**
     * ObjectId reference to the History document that triggered a debit.
     * Only set for kind='debit'.
     */
    historyId: {
      type: Schema.ObjectId,
    },
    /**
     * Generic external reference string.
     * Used for: debit idempotency key, expiration ref ('expire-<entryId>'),
     * adjustment memo, or grant idempotency key ('signup_grant-<orgId>').
     */
    refId: {
      type: String,
    },
    /**
     * Credit source tag — discriminates pack purchases from grants.
     * 'signup_grant' — one-shot free tier grant on org creation.
     * 'adjustment'   — manual ops credit (non-Stripe).
     * Omitted for kind='topup' entries created by creditPack (Stripe path).
     */
    source: {
      type: String,
      enum: ['signup_grant', 'adjustment'],
    },
    at: {
      type: Date,
      default: Date.now,
    },
    /**
     * Expiry date for topup entries.
     * Only set on kind='topup' when the pack has a finite lifespan.
     */
    expiresAt: {
      type: Date,
    },
  },
  { _id: true },
);

const ExtraBalanceMongoose = new Schema(
  {
    organization: {
      type: Schema.ObjectId,
      ref: 'Organization',
      required: true,
      unique: true,
    },
    ledger: {
      type: [LedgerEntrySchema],
      default: () => [],
    },
    /**
     * Running total of available meter units.
     * Updated atomically on every write (via $inc) to avoid full ledger scans.
     * May temporarily diverge from sum(ledger.amount) during partial expiration
     * sweeps; addExpirationEntries + cachedBalance update is always atomic.
     */
    cachedBalance: {
      type: Number,
      default: 0,
    },
    cachedBalanceAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Index for idempotent topup lookups — check if a stripeSessionId was already
 * applied before pushing a new ledger entry.
 */
ExtraBalanceMongoose.index({ 'ledger.stripeSessionId': 1 }, { sparse: true });

/**
 * Index for debit replay protection — check if a historyId was already debited.
 */
ExtraBalanceMongoose.index({ 'ledger.historyId': 1 }, { sparse: true });

/**
 * Index for expiration sweeps — find topup entries with expiresAt in the past.
 */
ExtraBalanceMongoose.index({ 'ledger.expiresAt': 1 }, { sparse: true });

/**
 * Index for grant analytics + idempotency support.
 * refId is the leading key for analytics and admin queries that filter grant entries by refId prefix.
 * source is a trailing key for filtering entries by grant type (e.g. all signup_grant entries).
 * Note: the creditGrant idempotency guard (`ledger.refId: {$ne: key}`) is an exclusion predicate
 * scoped by the unique `organization` field — it does not use tight index bounds, but the sparse
 * index still reduces the scan set to grant entries only.
 */
ExtraBalanceMongoose.index({ 'ledger.refId': 1, 'ledger.source': 1 }, { sparse: true });

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
ExtraBalanceMongoose.virtual('id').get(addID);
ExtraBalanceMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('BillingExtraBalance', ExtraBalanceMongoose);
