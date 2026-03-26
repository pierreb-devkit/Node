/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import config from '../../../config/index.js';

const Schema = mongoose.Schema;

const ttlSeconds = (config.audit?.ttlDays || 90) * 86400;

/**
 * AuditLog Mongoose Schema
 */
const AuditLogSchema = new Schema(
  {
    action: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: Schema.ObjectId,
      ref: 'User',
      index: true,
    },
    orgId: {
      type: Schema.ObjectId,
      ref: 'Organization',
      index: true,
    },
    targetType: {
      type: String,
      default: '',
    },
    targetId: {
      type: String,
      default: '',
    },
    ip: {
      type: String,
      default: '',
    },
    userAgent: {
      type: String,
      default: '',
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

// TTL index — automatically removes documents after ttlDays
AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlSeconds });

/**
 * @desc Function to add id (+ _id) to all objects
 * @return {String} hex string of _id
 */
function addID() {
  return this._id.toHexString();
}

/**
 * Model configuration
 */
AuditLogSchema.virtual('id').get(addID);
// Ensure virtual fields are serialised.
AuditLogSchema.set('toJSON', {
  virtuals: true,
});

mongoose.model('AuditLog', AuditLogSchema);
