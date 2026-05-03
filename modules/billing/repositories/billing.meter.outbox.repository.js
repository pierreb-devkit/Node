/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import { getOutboxMaxRetryAttempts } from '../lib/billing.constants.js';

/**
 * @function BillingMeterOutbox
 * @description Lazily resolves the BillingMeterOutbox Mongoose model.
 *              Deferred to keep unit tests importable before model registration.
 * @returns {import('mongoose').Model} The registered BillingMeterOutbox model.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const BillingMeterOutbox = () => mongoose.model('BillingMeterOutbox');

/**
 * @function create
 * @description Insert a pending outbox row for a deferred extras debit.
 * @param {Object} payload - Outbox row fields.
 * @param {string} payload.organizationId - Organization ObjectId.
 * @param {string} payload.idempotencyKey - Usage attribution idempotency key.
 * @param {number} payload.extrasUnits - Extras units to debit.
 * @param {Object} [options={}] - Optional write options.
 * @param {import('mongoose').ClientSession} [options.session] - Optional Mongo session.
 * @returns {Promise<Object>} Inserted outbox document.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const create = async ({ organizationId, idempotencyKey, extrasUnits }, options = {}) => {
  const docs = await BillingMeterOutbox().create(
    [{
      organizationId,
      idempotencyKey,
      extrasUnits,
      status: 'pending',
    }],
    options.session ? { session: options.session } : undefined,
  );
  return docs[0];
};

/**
 * @function findPendingDue
 * @description Return pending outbox rows whose last attempt is due for retry.
 *              Rows with lastAttemptedAt=null are due immediately.
 * @param {number} [thresholdMs=300000] - Retry backoff threshold in milliseconds.
 * @param {number} [limit=100] - Maximum rows to return.
 * @returns {Promise<Object[]>} Pending due outbox rows.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const findPendingDue = (thresholdMs = 5 * 60 * 1000, limit = 100) => {
  const dueBefore = new Date(Date.now() - thresholdMs);
  return BillingMeterOutbox()
    .find({
      status: 'pending',
      $or: [
        { lastAttemptedAt: null },
        { lastAttemptedAt: { $lt: dueBefore } },
      ],
    })
    .sort({ lastAttemptedAt: 1, createdAt: 1 })
    .limit(limit)
    .lean();
};

/**
 * @function findByIdempotencyKey
 * @description Fetch an outbox row by its idempotency key.
 * @param {string} idempotencyKey - Usage attribution idempotency key.
 * @returns {Promise<Object|null>} Matching outbox row or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const findByIdempotencyKey = (idempotencyKey) =>
  BillingMeterOutbox().findOne({ idempotencyKey }).lean();

/**
 * @function markCommitted
 * @description Mark an outbox row as committed after a successful extras debit.
 *              The `status:'pending'` filter makes this idempotent: committed or
 *              failed rows are immutable and concurrent calls are no-ops.
 * @param {string} id - Outbox row id.
 * @returns {Promise<Object>} Mongo update result.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const markCommitted = (id) =>
  BillingMeterOutbox().updateOne(
    { _id: id, status: 'pending' },
    { $set: { status: 'committed', lastError: null, lastAttemptedAt: new Date() } },
  );

/**
 * @function markFailedAttempt
 * @description Record a failed debit attempt. The fifth failed attempt exhausts
 *              the row and moves it to failed status atomically. The status
 *              transition uses `{ status: 'pending' }` as a filter on the
 *              exhaustion update so that concurrent cron runs cannot emit
 *              duplicate exhausted events.
 * @param {string} id - Outbox row id.
 * @param {Error|string} error - Failure to record.
 * @returns {Promise<Object|null>} Updated outbox row after failure accounting.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const markFailedAttempt = async (id, error) => {
  const message = error?.message ?? String(error);
  const attemptedAt = new Date();
  const maxRetryAttempts = getOutboxMaxRetryAttempts();

  const nextAttempts = { $add: [{ $ifNull: ['$attempts', 0] }, 1] };

  return BillingMeterOutbox().findOneAndUpdate(
    { _id: id, status: 'pending' },
    [
      {
        $set: {
          attempts: nextAttempts,
          lastError: message,
          lastAttemptedAt: attemptedAt,
          status: {
            $cond: [
              { $gte: [nextAttempts, maxRetryAttempts] },
              'failed',
              '$status',
            ],
          },
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).lean();
};

export default {
  create,
  findPendingDue,
  findByIdempotencyKey,
  markCommitted,
  markFailedAttempt,
};
