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
      required: true,
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
  },
  {
    timestamps: true,
  },
);

/**
 * Compound unique index to prevent duplicate memberships
 */
MembershipMongoose.index({ userId: 1, organizationId: 1 }, { unique: true });

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
