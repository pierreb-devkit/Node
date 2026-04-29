/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * BillingPlan Data Model Mongoose
 *
 * Versioned plan definitions for compute-based pricing.
 * Each (planId, version) pair is immutable after creation.
 * Use bumpVersion to create a new version and deactivate the previous one.
 */
const BillingPlanMongoose = new Schema(
  {
    planId: {
      type: String,
      required: true,
      trim: true,
    },
    version: {
      type: String,
      required: true,
      trim: true,
    },
    computeQuota: {
      type: Number,
      required: true,
      min: 0,
    },
    stripePriceMonthly: {
      type: String,
      trim: true,
      sparse: true,
    },
    stripePriceAnnual: {
      type: String,
      trim: true,
      sparse: true,
    },
    /**
     * Flexible ratio map for compute unit attribution.
     * Each key is a feature name; each value is a non-negative finite number.
     * Example: { scrap: 1, autofix: 2, wizard: 5 }
     */
    ratios: {
      type: Schema.Types.Mixed,
      default: () => ({}),
      validate: {
        validator(value) {
          return (
            value != null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.values(value).every((n) => Number.isFinite(n) && n >= 0)
          );
        },
        message: 'ratios must be an object whose values are finite numbers >= 0',
      },
    },
    effectiveFrom: {
      type: Date,
      required: true,
    },
    effectiveUntil: {
      type: Date,
      default: null,
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Unique index per (planId, version) — immutable identity
 */
BillingPlanMongoose.index({ planId: 1, version: 1 }, { unique: true });

/**
 * Compound index to look up the active plan for a given planId efficiently
 */
BillingPlanMongoose.index({ planId: 1, active: 1, effectiveUntil: 1 });

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
BillingPlanMongoose.virtual('id').get(addID);
BillingPlanMongoose.set('toJSON', {
  virtuals: true,
});

mongoose.model('BillingPlan', BillingPlanMongoose);
