/**
 * Module dependencies
 */
import responses from '../../../lib/helpers/responses.js';
import getStripe from '../lib/stripe.js';

/**
 * @desc Admin endpoint to trigger a Stripe refund for a charge.
 *       Initiates the Stripe refund; actual ledger debit happens via the
 *       `charge.refunded` webhook (single source of truth).
 *       Idempotency: uses caller-provided refundRequestId when present to prevent
 *       double-refund on admin double-click. Falls back to minute-resolution key
 *       when refundRequestId is absent — 2 clicks within the same minute → 1 refund.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const adminRefundCharge = async (req, res) => {
  try {
    const { chargeId, amountCents, reason, refundRequestId } = req.body;

    if (typeof chargeId !== 'string' || chargeId.trim() === '') {
      return responses.error(res, 422, 'Unprocessable Entity', 'Failed to refund charge')(
        new Error('invalid argument: chargeId must be a non-empty string'),
      );
    }
    if (amountCents !== undefined) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return responses.error(res, 422, 'Unprocessable Entity', 'Failed to refund charge')(
          new Error('invalid argument: amountCents must be a positive integer'),
        );
      }
    }

    const stripe = getStripe();
    if (!stripe) {
      return responses.error(res, 502, 'Bad Gateway', 'Failed to refund charge')(
        new Error('Stripe is not configured'),
      );
    }

    // Prefer caller-supplied stable key; fall back to minute-resolution to bound double-click window.
    const idempotencyKey = refundRequestId
      ? `refund_admin_${refundRequestId}`
      : `refund_${chargeId}_${amountCents ?? 'full'}_${Math.floor(Date.now() / 60000)}`;

    const params = { charge: chargeId, reason: reason || 'requested_by_customer' };
    if (amountCents !== undefined) params.amount = amountCents;

    const refund = await stripe.refunds.create(params, { idempotencyKey });
    responses.success(res, 'billing refund created')(refund);
  } catch (err) {
    const status = err.message?.startsWith('invalid argument') ? 422 : 502;
    const title = status === 422 ? 'Unprocessable Entity' : 'Bad Gateway';
    responses.error(res, status, title, 'Failed to refund charge')(err);
  }
};

export default {
  adminRefundCharge,
};
