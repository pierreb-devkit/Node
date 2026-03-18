/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const BillingUsage = mongoose.model('BillingUsage');

const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/;

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
const increment = async (organizationId, month, key, amount) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;
  if (!SAFE_KEY_RE.test(key)) throw new Error(`Invalid counter key: ${key}`);
  try {
    return await BillingUsage.findOneAndUpdate(
      { organizationId, month },
      { $inc: { [`counters.${key}`]: amount } },
      { upsert: true, returnDocument: 'after', runValidators: true },
    ).exec();
  } catch (err) {
    if (err.code === 11000) {
      return BillingUsage.findOneAndUpdate(
        { organizationId, month },
        { $inc: { [`counters.${key}`]: amount } },
        { returnDocument: 'after', runValidators: true },
      ).exec();
    }
    throw err;
  }
};

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
    { returnDocument: 'after', runValidators: true },
  ).exec();
};

export default {
  get,
  increment,
  reset,
};
