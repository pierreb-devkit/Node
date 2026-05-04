/**
 * Module dependencies
 */
import responses from '../../../lib/helpers/responses.js';
import getStripe from '../lib/stripe.js';

/**
 * @desc Admin endpoint to trigger a Stripe refund for a charge.
 *       Initiates the Stripe refund; actual ledger debit happens via the
 *       `charge.refunded` webhook (single source of truth).
 *       Idempotency: refundRequestId is required (frontend generates a UUID per click)
 *       to prevent double-refund on admin double-click at any time interval.
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

    if (typeof refundRequestId !== 'string' || refundRequestId.trim().length < 8) {
      return responses.error(res, 422, 'Unprocessable Entity', 'Failed to refund charge')(
        new Error('invalid argument: refundRequestId must be a string of at least 8 characters'),
      );
    }

    const stripe = getStripe();
    if (!stripe) {
      return responses.error(res, 502, 'Bad Gateway', 'Failed to refund charge')(
        new Error('Stripe is not configured'),
      );
    }

    const idempotencyKey = `refund_admin_${refundRequestId}`;
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
