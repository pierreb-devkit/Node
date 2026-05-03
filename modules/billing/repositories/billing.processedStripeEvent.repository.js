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
 * @description Atomically insert a new processed event document.
 *              If a document with the same eventId already exists (E11000 duplicate key),
 *              returns `{ recorded: false }` instead of throwing — idempotency by design.
 *              On success, returns `{ recorded: true }`.
 * @param {string} eventId - Stripe event ID (unique idempotency key).
 * @param {string} type - Stripe event type (e.g. 'checkout.session.completed').
 * @returns {Promise<{recorded: boolean}>}
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
    return { recorded: true };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return { recorded: false };
    }
    throw err;
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

export default {
  tryRecord,
  wasProcessed,
  deleteByEventId,
};
