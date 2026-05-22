/**
 * Module dependencies
 */
import mongoose from 'mongoose';

/**
 * @function BillingFailedBackfill
 * @description Lazily resolves the BillingFailedBackfill Mongoose model.
 *              Deferred to keep unit tests importable before model registration.
 * @returns {import('mongoose').Model} The registered BillingFailedBackfill model.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const BillingFailedBackfill = () => mongoose.model('BillingFailedBackfill');

/**
 * @function record
 * @description Write a dead-letter entry for a PaymentIntent metadata backfill failure.
 *              Called by billing.webhook.service after all retry attempts are exhausted.
 * @param {object} opts
 * @param {string} opts.paymentIntentId - Stripe PaymentIntent id (pi_*).
 * @param {string} opts.stripeSessionId - Stripe checkout session id (cs_*).
 * @param {string|null} [opts.error]    - Serialised error message from the last failed attempt.
 * @param {Date}   [opts.failedAt]      - Timestamp of the failure (defaults to now).
 * @returns {Promise<import('mongoose').Document>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const record = ({ paymentIntentId, stripeSessionId, error = null, failedAt = new Date() }) =>
  BillingFailedBackfill().create({ paymentIntentId, stripeSessionId, error, failedAt });

export default { record };
