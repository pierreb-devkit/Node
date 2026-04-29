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

/**
 * @function findByWeek
 * @description Fetch a single usage document by organizationId and weekKey.
 * @param {String} organizationId - The organization ID.
 * @param {String} weekKey - The ISO week key in YYYY-Www format.
 * @returns {Promise<Object|null>} The usage document (plain object) or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const findByWeek = (organizationId, weekKey) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;
  return BillingUsage.findOne({ organizationId, weekKey }).lean();
};

/**
 * @function incrementMeter
 * @description Atomically increment meter usage for the given org+weekKey, with upsert.
 *              Replay protection: the idempotencyKey is appended to consumedHistoryIds;
 *              if it is already present, the update is skipped (returns null).
 *              baseSnapshot fields ($setOnInsert) are only written on document creation,
 *              preserving the quota snapshot for the lifetime of the week.
 *
 * @param {String} organizationId - The organization ID.
 * @param {String} weekKey - The ISO week key in YYYY-Www format.
 * @param {Number} units - Meter units to add.
 * @param {Object} breakdown - Feature-level breakdown map { featureKey: units }.
 * @param {String} idempotencyKey - Unique key (usually history._id.toString()) for replay protection.
 * @param {Object} baseSnapshot - Fields written only on first upsert: { meterQuota, planVersion, resetAt, month }.
 * @returns {Promise<Object|null>} The updated usage document, or null if this was a replay (no-op).
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const incrementMeter = async (organizationId, weekKey, units, breakdown, idempotencyKey, baseSnapshot) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;

  // Build $inc for meterUsed + per-feature breakdown keys
  const incPayload = { meterUsed: units };
  if (breakdown && typeof breakdown === 'object') {
    for (const [key, value] of Object.entries(breakdown)) {
      if (SAFE_KEY_RE.test(key)) {
        incPayload[`meterBreakdown.${key}`] = value;
      }
    }
  }

  try {
    const doc = await BillingUsage.findOneAndUpdate(
      {
        organizationId,
        weekKey,
        consumedHistoryIds: { $ne: idempotencyKey },
      },
      {
        $inc: incPayload,
        $push: { consumedHistoryIds: idempotencyKey },
        $setOnInsert: {
          organizationId,
          weekKey,
          month: baseSnapshot?.month ?? weekKey.slice(0, 7),
          meterQuota: baseSnapshot?.meterQuota ?? 0,
          planVersion: baseSnapshot?.planVersion ?? null,
          resetAt: baseSnapshot?.resetAt ?? null,
        },
      },
      { upsert: true, returnDocument: 'after', runValidators: false },
    );
    return doc;
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key on upsert race — retry without upsert
      return BillingUsage.findOneAndUpdate(
        {
          organizationId,
          weekKey,
          consumedHistoryIds: { $ne: idempotencyKey },
        },
        {
          $inc: incPayload,
          $push: { consumedHistoryIds: idempotencyKey },
        },
        { returnDocument: 'after' },
      );
    }
    throw err;
  }
};

export default {
  get,
  increment,
  reset,
  findByWeek,
  incrementMeter,
};
