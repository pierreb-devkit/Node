/**
 * Module dependencies
 */
import getStripe from '../lib/stripe.js';

/**
 * @function refundCharge
 * @description Initiate a Stripe refund for a given charge.
 *              Wraps stripe.refunds.create with a deterministic idempotency key so
 *              retries on network failures never create duplicate refunds.
 *              The actual ledger debit happens via the `charge.refunded` webhook
 *              (single source of truth) — this service ONLY initiates the Stripe refund.
 *
 * @param {string} stripeChargeId - Stripe charge ID (ch_xxx). Must be non-empty.
 * @param {number|undefined} [amountCents] - Amount to refund in cents. Omit for full refund. Must be > 0 if provided.
 * @returns {Promise<Object>} The Stripe refund object.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const refundCharge = async (stripeChargeId, amountCents) => {
  if (typeof stripeChargeId !== 'string' || stripeChargeId.trim() === '') {
    throw new Error('invalid argument: stripeChargeId must be a non-empty string');
  }
  if (amountCents !== undefined) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error('invalid argument: amountCents must be a positive integer');
    }
  }

  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured');

  const idempotencyKey = `refund_${stripeChargeId}_${amountCents ?? 'full'}`;

  const params = {
    charge: stripeChargeId,
    reason: 'requested_by_customer',
  };
  if (amountCents !== undefined) {
    params.amount = amountCents;
  }

  return stripe.refunds.create(params, { idempotencyKey });
};

export default {
  refundCharge,
};
