/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const BillingUsage = mongoose.model('BillingUsage');

/**
 * @function get
 * @description Fetch a single usage document by organizationId and month.
 * @param {String} organizationId - The organization ID.
 * @param {String} month - The month in YYYY-MM format.
 * @returns {Promise<Object|null>} The usage document or null.
 */
const get = (organizationId, month) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;
  return BillingUsage.findOne({ organizationId, month }).exec();
};

/**
 * @function increment
 * @description Atomically increment a counter key for the given org+month, with upsert.
 * @param {String} organizationId - The organization ID.
 * @param {String} month - The month in YYYY-MM format.
 * @param {String} key - The counter key to increment (e.g. 'executions').
 * @param {Number} amount - The amount to increment by.
 * @returns {Promise<Object>} The updated usage document.
 */
const increment = (organizationId, month, key, amount) => BillingUsage.findOneAndUpdate(
  { organizationId, month },
  { $inc: { [`counters.${key}`]: amount } },
  { upsert: true, returnDocument: 'after', runValidators: true },
).exec();

/**
 * @function reset
 * @description Reset all counters to an empty object for the given org+month.
 * @param {String} organizationId - The organization ID.
 * @param {String} month - The month in YYYY-MM format.
 * @returns {Promise<Object|null>} The updated usage document or null.
 */
const reset = (organizationId, month) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;
  return BillingUsage.findOneAndUpdate(
    { organizationId, month },
    { $set: { counters: {} } },
    { returnDocument: 'after' },
  ).exec();
};

export default {
  get,
  increment,
  reset,
};
