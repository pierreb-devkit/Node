/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const BillingPlan = () => mongoose.model('BillingPlan');

/**
 * @function findActive
 * @description Fetch the currently active plan for a given planId.
 *              Filters on { planId, active: true, effectiveUntil: null }.
 * @param {string} planId - The logical plan identifier (e.g. "pro").
 * @returns {Promise<Object|null>} The active BillingPlan plain object, or null.
 */
const findActive = (planId) =>
  BillingPlan().findOne({ planId, active: true, effectiveUntil: null }).lean();

/**
 * @function findByVersion
 * @description Fetch a specific plan snapshot by (planId, version).
 *              Useful for replay / attribution on historical records.
 * @param {string} planId - The logical plan identifier.
 * @param {string} version - The specific version string (e.g. "v2").
 * @returns {Promise<Object|null>} The BillingPlan plain object, or null.
 */
const findByVersion = (planId, version) =>
  BillingPlan().findOne({ planId, version }).lean();

/**
 * @function deactivateAll
 * @description Mark all currently active plan versions for a planId as inactive.
 *              Sets active=false and effectiveUntil=now for all matching docs.
 *              Safe to call when 0 active plans exist (no-op).
 * @param {string} planId - The logical plan identifier.
 * @param {Date} now - The timestamp to record as effectiveUntil.
 * @returns {Promise<Object>} Mongoose updateMany result ({ modifiedCount, ... }).
 */
const deactivateAll = (planId, now) =>
  BillingPlan().updateMany(
    { planId, active: true },
    { $set: { active: false, effectiveUntil: now } },
  );

/**
 * @function count
 * @description Count all plan versions for a given planId (active and inactive).
 *              Used by bumpVersion to derive the next sequential version number.
 * @param {string} planId - The logical plan identifier.
 * @returns {Promise<number>} Total document count for the planId.
 */
const count = (planId) => BillingPlan().countDocuments({ planId });

/**
 * @function create
 * @description Persist a new BillingPlan document to the database.
 * @param {Object} doc - The plan document to create.
 * @returns {Promise<Object>} The created BillingPlan document (Mongoose doc).
 */
const create = (doc) => BillingPlan().create(doc);

export default {
  findActive,
  findByVersion,
  deactivateAll,
  count,
  create,
};
