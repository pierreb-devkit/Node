/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Data Model Mongoose
 */
const TaskMongoose = new Schema(
  {
    title: String,
    description: String,
    user: {
      type: Schema.ObjectId,
      ref: 'User',
    },
    organizationId: {
      type: Schema.ObjectId,
      ref: 'Organization',
    },
  },
  {
    timestamps: true,
  },
);

/**
 * @desc Virtual getter returning the document id as a hex string
 * @this {import('mongoose').Document & {_id: import('mongoose').Types.ObjectId}}
 * @return {string} id
 */
function addID() {
  return this._id.toHexString();
}

/**
 * Model configuration
 */
TaskMongoose.virtual('id').get(addID);
// Ensure virtual fields are serialised.
TaskMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('Task', TaskMongoose);
