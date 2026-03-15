/**
 * Module dependencies
 */
import mongoose from 'mongoose';

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
      enum: ['active', 'pending', 'rejected', 'invited'],
      default: 'active',
    },
    inviteToken: { type: String, default: null },
    invitedEmail: { type: String, default: null },
    inviteExpiresAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  },
);

/**
 * Compound unique index to prevent duplicate memberships
 */
MembershipMongoose.index(
  { userId: 1, organizationId: 1 },
  { unique: true, partialFilterExpression: { userId: { $exists: true, $ne: null } } },
);

/**
 * Sparse index on inviteToken for invite lookups
 */
MembershipMongoose.index({ inviteToken: 1 }, { sparse: true });

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
