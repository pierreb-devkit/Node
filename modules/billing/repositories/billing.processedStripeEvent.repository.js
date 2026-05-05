/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import { isDuplicateKeyError } from '../lib/billing.errors.js';

/**
 * Lazily resolves the ProcessedStripeEvent Mongoose model.
 * Deferred to keep unit tests importable before model registration.
 * @returns {import('mongoose').Model} The registered ProcessedStripeEvent model.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const ProcessedStripeEvent = () => mongoose.model('ProcessedStripeEvent');

/**
 * @function tryRecord
 * @description Atomically claim a Stripe event for processing using the unique index on eventId.
 *              Returns 3-state semantics so withIdempotency can persist `attempts` across Stripe
 *              redeliveries (the previous design deleted the doc on rollback, which reset attempts
 *              and made the dead-letter branch unreachable):
 *                - New doc inserted → `{ recorded: true, retry: false }` (first delivery)
 *                - Existing doc, `deadLetter: true` → `{ recorded: false, reason: 'dead_letter' }`
 *                  (we already gave up — return success to Stripe so it stops retrying)
 *                - Existing doc, `attempts > 0 && !deadLetter` → `{ recorded: true, retry: true }`
 *                  (a previous run failed and was kept on disk; allow re-entry so attempts persists)
 *                - Existing doc, `attempts === 0 && !deadLetter` → `{ recorded: false,
 *                  reason: 'already_processed' }` (handler succeeded last time; never increment on
 *                  success, so attempts === 0 is the terminal-success signal)
 *
 *              No `pendingRetry` field is added — the (attempts, deadLetter) pair already encodes
 *              the four states unambiguously.
 * @param {string} eventId - Stripe event ID (unique idempotency key).
 * @param {string} type - Stripe event type (e.g. 'checkout.session.completed').
 * @returns {Promise<{recorded: boolean, retry?: boolean, reason?: string}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const tryRecord = async (eventId, type) => {
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    throw new Error('invalid argument: eventId must be a non-empty string');
  }
  if (typeof type !== 'string' || type.trim() === '') {
    throw new Error('invalid argument: type must be a non-empty string');
  }

  try {
    await ProcessedStripeEvent().create({ eventId, type, processedAt: new Date() });
    return { recorded: true, retry: false };
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    // Existing doc — inspect state to decide whether to allow re-entry.
    const existing = await ProcessedStripeEvent().findOne({ eventId }).lean();
    if (!existing) {
      // Race window: doc was deleted between insert-fail and lookup. Treat as already_processed
      // (TTL or admin cleanup) — safest is to skip and keep Stripe quiet.
      return { recorded: false, reason: 'already_processed' };
    }
    if (existing.deadLetter) {
      return { recorded: false, reason: 'dead_letter' };
    }
    if ((existing.attempts ?? 0) > 0) {
      // Pending retry — previous run failed, attempts persisted. Allow handler re-entry.
      return { recorded: true, retry: true };
    }
    // attempts === 0 && !deadLetter → handler succeeded on first delivery (we never increment on success).
    return { recorded: false, reason: 'already_processed' };
  }
};

/**
 * @function wasProcessed
 * @description Check whether a Stripe event has already been processed.
 *              Optional helper — primarily useful for admin tooling and tests.
 * @param {string} eventId - Stripe event ID to look up.
 * @returns {Promise<boolean>} True if the event was already recorded, false otherwise.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const wasProcessed = async (eventId) => {
  if (typeof eventId !== 'string' || eventId.trim() === '') return false;
  const doc = await ProcessedStripeEvent().findOne({ eventId }).lean();
  return doc !== null;
};

/**
 * @function deleteByEventId
 * @description Delete the processed event record for the given eventId.
 *              Called by withIdempotency rollback when the handler throws — allows
 *              Stripe to retry the event on a subsequent delivery.
 *              Returns { deleted: true } if a document was removed, { deleted: false } if none found.
 * @param {string} eventId - Stripe event ID to remove.
 * @returns {Promise<{deleted: boolean}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const deleteByEventId = async (eventId) => {
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    throw new Error('invalid argument: eventId must be a non-empty string');
  }
  const result = await ProcessedStripeEvent().deleteOne({ eventId });
  return { deleted: result.deletedCount > 0 };
};

/**
 * @function incrementAttempts
 * @description Atomically increment the attempts counter and record the last error details
 *              on the processed event document. Used by withIdempotency to track retry depth.
 * @param {string} eventId - Stripe event ID.
 * @param {string} errorMessage - Error message from the last failed handler execution.
 * @returns {Promise<Object|null>} Updated document or null if not found.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const incrementAttempts = async (eventId, errorMessage) => {
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    throw new Error('invalid argument: eventId must be a non-empty string');
  }
  return ProcessedStripeEvent().findOneAndUpdate(
    { eventId },
    {
      $inc: { attempts: 1 },
      $set: { lastError: String(errorMessage ?? ''), lastErrorAt: new Date() },
    },
    { returnDocument: 'after' },
  ).exec();
};

/**
 * @function markDeadLetter
 * @description Mark a processed event as dead-lettered — keeps the claim permanently so
 *              Stripe stops retrying, and sets deadLetter=true for ops visibility.
 * @param {string} eventId - Stripe event ID.
 * @returns {Promise<Object|null>} Updated document or null if not found.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const markDeadLetter = async (eventId) => {
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    throw new Error('invalid argument: eventId must be a non-empty string');
  }
  return ProcessedStripeEvent().findOneAndUpdate(
    { eventId },
    { $set: { deadLetter: true } },
    { returnDocument: 'after' },
  ).exec();
};

export default {
  tryRecord,
  wasProcessed,
  deleteByEventId,
  incrementAttempts,
  markDeadLetter,
};
