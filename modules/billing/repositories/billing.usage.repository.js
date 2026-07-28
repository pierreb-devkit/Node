/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import { isDuplicateKeyError } from '../lib/billing.errors.js';

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
 *              `$setOnInsert: { legacyPeriod: true }` marks newly-created documents as
 *              legacy (non-meter) — the discriminator the (organizationId, month) unique
 *              partial index filters on (see model comment; meter-mode documents, created
 *              via incrementMeter/upsertWeekSnapshot, never set this field).
 * @param {String} organizationId - The organization ID.
 * @param {String} month - The month in YYYY-MM format.
 * @param {String} key - The counter key to increment (e.g. 'executions').
 * @param {Number} amount - The amount to increment by.
 * @returns {Promise<Object|null>} The updated usage document, or `null` when
 *   `organizationId` is not a valid ObjectId (no write attempted), or
 *   (anomalous — see `BillingUsageService.increment`, which logs this loudly)
 *   `null` when a duplicate-key retry's exact-match filter finds nothing,
 *   meaning the write was lost. Should not happen in normal operation
 *   post-#3991 (the retry filter is `{organizationId, month}`, identical to
 *   what the winning concurrent upsert just created), but is not asserted
 *   against here — the repository stays a thin data layer; callers decide how
 *   loud to be.
 */
const increment = async (organizationId, month, key, amount) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;
  if (!SAFE_KEY_RE.test(key)) throw new Error(`Invalid counter key: ${key}`);
  try {
    return await BillingUsage.findOneAndUpdate(
      { organizationId, month },
      { $inc: { [`counters.${key}`]: amount }, $setOnInsert: { legacyPeriod: true } },
      { upsert: true, returnDocument: 'after', runValidators: true },
    ).exec();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
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
 *              Replay protection: the idempotencyKey is appended to consumedAttributionKeys;
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
 * @param {Object} [options={}] - Optional write options.
 * @param {import('mongoose').ClientSession} [options.session] - Optional Mongo session for transaction-scoped writes.
 * @returns {Promise<Object|null>} The updated usage document, or null if this was a replay (no-op).
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const incrementMeter = async (organizationId, weekKey, units, breakdown, idempotencyKey, baseSnapshot, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;

  // Build $inc for meterUsed + per-feature breakdown keys
  // Only include entries with a finite positive value to avoid invalid $inc operations.
  const incPayload = { meterUsed: units };
  if (breakdown && typeof breakdown === 'object') {
    for (const [key, value] of Object.entries(breakdown)) {
      if (SAFE_KEY_RE.test(key) && Number.isFinite(value) && value > 0) {
        incPayload[`meterBreakdown.${key}`] = value;
      }
    }
  }
  const hasBreakdownIncrements = Object.keys(incPayload).some((key) => key.startsWith('meterBreakdown.'));

  const filter = {
    organizationId,
    weekKey,
    consumedAttributionKeys: { $ne: idempotencyKey },
  };

  try {
    const doc = await BillingUsage.findOneAndUpdate(
      filter,
      {
        $inc: incPayload,
        $push: { consumedAttributionKeys: idempotencyKey },
        $setOnInsert: {
          organizationId,
          weekKey,
          // Derive a valid YYYY-MM month from the weekKey as fallback.
          // weekKey has format 'YYYY-Www' (e.g. '2026-W18'); slicing 7 chars gives 'YYYY-W'
          // which is not a valid month. Instead parse the year from weekKey and use current month.
          month: baseSnapshot?.month ?? (() => {
            const now = new Date();
            return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
          })(),
          meterQuota: baseSnapshot?.meterQuota ?? 0,
          planVersion: baseSnapshot?.planVersion ?? null,
          resetAt: baseSnapshot?.resetAt ?? null,
          ...(hasBreakdownIncrements ? {} : { meterBreakdown: {} }),
          alertedAt80: null,
          alertedAt100: null,
        },
      },
      {
        upsert: true,
        returnDocument: 'after',
        runValidators: false,
        strict: false,
        strictQuery: false,
        session: options.session,
      },
    );
    return doc;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      // Duplicate key on upsert race — retry without upsert
      return BillingUsage.findOneAndUpdate(
        filter,
        {
          $inc: incPayload,
          $push: { consumedAttributionKeys: idempotencyKey },
        },
        { returnDocument: 'after', strict: false, strictQuery: false, session: options.session },
      );
    }
    throw err;
  }
};

/**
 * @function archiveOtherWeeks
 * @description Atomically set archivedAt on all active usage documents for an org
 *              whose weekKey does NOT match currentWeekKey.
 *              Idempotent: documents already bearing archivedAt are excluded by the filter.
 * @param {string} orgId - The organization ObjectId (string).
 * @param {string} currentWeekKey - The week key to preserve (not archived).
 * @param {Date} archivedAt - Timestamp to stamp on archived documents.
 * @returns {Promise<{modifiedCount: number}>} Mongoose updateMany result.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const archiveOtherWeeks = (orgId, currentWeekKey, archivedAt) =>
  BillingUsage.updateMany(
    {
      organizationId: orgId,
      weekKey: { $ne: currentWeekKey },
      archivedAt: null,
    },
    { $set: { archivedAt } },
  );

/**
 * @function upsertWeekSnapshot
 * @description Upsert a new weekly usage document with snapshot fields ($setOnInsert only).
 *              If the document already exists, the operation is a no-op (idempotent).
 *              Throws with code 11000 on a race — callers should catch and re-fetch.
 * @param {string} orgId - The organization ObjectId (string).
 * @param {string} weekKey - The ISO week key for the new period.
 * @param {Object} snapshotFields - Fields written only on document creation
 *   (organizationId, weekKey, month, meterUsed, meterQuota, planVersion,
 *    meterBreakdown, resetAt, alertedAt80, alertedAt100, consumedAttributionKeys).
 * @returns {Promise<Object>} The upserted document.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const upsertWeekSnapshot = (orgId, weekKey, snapshotFields) =>
  BillingUsage.findOneAndUpdate(
    { organizationId: orgId, weekKey },
    { $setOnInsert: snapshotFields },
    { upsert: true, returnDocument: 'after', runValidators: false },
  );

/**
 * @function rotateWeekSnapshotForPlanChange
 * @description Update an existing current-week usage document with the active
 *              plan snapshot. Preserves usage by default; optionally resets
 *              usage and clears the breakdown for clean-break plan changes.
 *              Does not upsert — plan-change rotation is only needed when a
 *              current week document already exists.
 * @param {string} orgId - The organization ObjectId (string).
 * @param {string} weekKey - The current ISO week key.
 * @param {Object} snapshotFields - Fields to set: { meterQuota, planVersion, month }.
 * @param {boolean} preserveUsage - Whether to keep existing meterUsed and breakdown.
 * @returns {Promise<Object|null>} The updated usage document, or null when none exists.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const rotateWeekSnapshotForPlanChange = (orgId, weekKey, snapshotFields, preserveUsage = true) => {
  const update = {
    $set: {
      meterQuota: snapshotFields.meterQuota,
      planVersion: snapshotFields.planVersion,
      month: snapshotFields.month,
    },
  };

  if (!preserveUsage) {
    update.$set.meterUsed = 0;
    update.$set.meterBreakdown = {};
    // Clear threshold flags so the new quota window can trigger alerts again.
    update.$set.alertedAt80 = null;
    update.$set.alertedAt100 = null;
  }

  return BillingUsage.findOneAndUpdate(
    { organizationId: orgId, weekKey },
    update,
    { returnDocument: 'after', runValidators: false },
  ).lean();
};

/**
 * @function markThreshold
 * @description Atomically set a threshold timestamp field on a usage document,
 *              only when the field is currently null (deduplication guard).
 *              Used by the service layer to record 80%/100% alert crossings.
 * @param {string} docId - The BillingUsage document _id (string).
 * @param {'alertedAt80'|'alertedAt100'} field - The threshold field to set.
 * @returns {Promise<{modifiedCount: number}>} Mongoose updateOne result.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const markThreshold = (docId, field) =>
  BillingUsage.updateOne(
    { _id: docId, [field]: null },
    { $set: { [field]: new Date() } },
  );

/**
 * @function countLegacyConsumedHistoryIds
 * @description Count usage documents that still carry the removed legacy migration field.
 * @returns {Promise<number>} Number of documents with consumedHistoryIds present.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const countLegacyConsumedHistoryIds = () =>
  BillingUsage.countDocuments({ consumedHistoryIds: { $exists: true } });

export default {
  get,
  increment,
  reset,
  findByWeek,
  incrementMeter,
  archiveOtherWeeks,
  upsertWeekSnapshot,
  rotateWeekSnapshotForPlanChange,
  markThreshold,
  countLegacyConsumedHistoryIds,
};
