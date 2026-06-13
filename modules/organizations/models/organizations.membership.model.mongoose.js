/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import { MEMBERSHIP_STATUSES, PENDING_SOURCES } from '../lib/constants.js';

const Schema = mongoose.Schema;

/**
 * Data Model Mongoose
 */
const MembershipMongoose = new Schema(
  {
    userId: {
      type: Schema.ObjectId,
      ref: 'User',
      default: null,
    },
    organizationId: {
      type: Schema.ObjectId,
      ref: 'Organization',
      required: true,
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'member'],
      default: 'member',
    },
    status: {
      type: String,
      enum: ['active', 'pending'],
      default: 'active',
    },
    // Consent discriminator for PENDING memberships. Intentionally NO default:
    // a forgotten `source` on a PENDING row must FAIL (pre-validate guard below),
    // never silently default to 'join_request' (which an owner could approve →
    // consent bypass). See PENDING_SOURCES in lib/constants.js.
    source: {
      type: String,
      enum: Object.values(PENDING_SOURCES),
    },
    // Provenance: the owner/admin who created an owner_add invitation (audit only).
    addedBy: {
      type: Schema.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Consent guard: a PENDING membership MUST declare an explicit source.
 * Without this, an owner_add that forgot to set `source` would be
 * indistinguishable from a join_request and could be approved by the owner,
 * bypassing the invited user's consent. Use the constant (status is stored
 * lowercase as MEMBERSHIP_STATUSES.PENDING — a `=== 'PENDING'` check is inert).
 *
 * Implemented as a no-arg sync hook that throws: mongoose rejects the validate()
 * promise on a thrown pre-hook error. (A `function(next)` signature is brittle here
 * — mongoose's arity detection can invoke it with no `next` under doc.validate().)
 */
MembershipMongoose.pre('validate', function enforcePendingSource() {
  if (this.status === MEMBERSHIP_STATUSES.PENDING && !this.source) {
    throw new Error('PENDING membership requires explicit source');
  }
});

/**
 * Compound unique index preventing duplicate (userId, organizationId) memberships.
 *
 * The partialFilterExpression uses `$type: 'objectId'` — NOT `$ne: null` — because
 * MongoDB does not support `$ne` (or `$not`) inside a partialFilterExpression. The
 * previous spec (`{ userId: { $exists: true, $ne: null } }`) was rejected
 * server-side on every build attempt; mongoose autoIndex reports that failure on
 * the model's 'index' event, where nothing listens, so the index NEVER existed on
 * any deployed database and duplicate protection silently fell back to the racy
 * findOne-then-create guards in the membership service (#3841). `$type: 'objectId'`
 * preserves the original intent: `userId: null` rows are BSON type null (not
 * objectId), so they stay outside the index and may repeat per organization.
 *
 * The migration (migrations/20260612120000-membership-user-org-unique-index.js) is
 * the AUTHORITATIVE creator; this declaration is its IDENTICAL twin (same key,
 * options, AND explicit name) so autoIndex / syncIndexes stay idempotent.
 */
MembershipMongoose.index(
  { userId: 1, organizationId: 1 },
  { unique: true, name: 'user_org_unique', partialFilterExpression: { userId: { $type: 'objectId' } } },
);

/**
 * Single-field index on organizationId for list-by-org queries
 */
MembershipMongoose.index({ organizationId: 1 });

/**
 * Compound index on organizationId + status for listing pending requests
 */
MembershipMongoose.index({ organizationId: 1, status: 1 });

/**
 * @desc Function to add id (+ _id) to all objects
 * @return {String} hex string of the ObjectId
 */
function addID() {
  return this._id.toHexString();
}

/**
 * Model configuration
 */
MembershipMongoose.virtual('id').get(addID);
// Ensure virtual fields are serialised.
MembershipMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('Membership', MembershipMongoose);
