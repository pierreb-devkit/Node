/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Signup Invitation Schema — a single-use, expiring invite that re-opens signup
 * for a specific email when public signup is disabled or capped.
 */
const InvitationMongoose = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    token: { type: String, required: true },
    invitedBy: { type: Schema.ObjectId, ref: 'User', default: null },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

InvitationMongoose.index({ token: 1 }, { unique: true });
InvitationMongoose.index({ email: 1 });

function addID() {
  return this._id.toHexString();
}
InvitationMongoose.virtual('id').get(addID);
InvitationMongoose.set('toJSON', { virtuals: true });

mongoose.model('Invitation', InvitationMongoose);
