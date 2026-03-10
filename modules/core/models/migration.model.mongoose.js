/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Migration tracking schema — records which migration files have been executed.
 */
const MigrationSchema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true,
  },
  executedAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
});

/**
 * @desc Function to add id (+ _id) to all objects
 * @returns {string} hex string of the document _id
 */
function addID() {
  return this._id.toHexString();
}

/**
 * Model configuration
 */
MigrationSchema.virtual('id').get(addID);
// Ensure virtual fields are serialised.
MigrationSchema.set('toJSON', {
  virtuals: true,
});

mongoose.model('Migration', MigrationSchema);
