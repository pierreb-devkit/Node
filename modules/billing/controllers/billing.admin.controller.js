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

/**
 * @desc Admin endpoint to override an organization's subscription plan.
 *       Restricted to plan changes only — never touches Stripe-driven status fields.
 *       Stripe remains source of truth for status / period / customer ids; this is
 *       a manual ops escape hatch (e.g. comp a user during support, force a plan
 *       during testing). The audit trail (adminUpdatedAt / adminUpdatedBy) is set
 *       by the repo method.
 *
 *       NOTE: this DOES NOT call Stripe. The downstream Stripe subscription remains
 *       on whatever plan the user is paying for. Use this only when the DB plan
 *       must diverge from Stripe (rare ops scenarios). To change the actual Stripe
 *       subscription, use the customer's Billing Portal or a separate Stripe API call.
 *
 * @param {Object} req - Express request object (req.body validated as AdminBumpPlanRequest)
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const adminBumpPlan = async (req, res) => {
  try {
    const { orgId, planId } = req.body;
    const adminUserId = String(req.user?._id ?? '');

    // Lazy imports — the repo module references mongoose.model('Subscription') at load time,
    // and the logger module touches config.log.fileLogger which isn't always mocked. Unrelated
    // unit tests that mock Stripe but don't load full schemas would crash on top-level imports.
    const { default: SubscriptionRepository } = await import('../repositories/billing.subscription.repository.js');
    const { default: logger } = await import('../../../lib/services/logger.js');

    const existing = await SubscriptionRepository.findByOrganization(orgId);
    if (!existing) {
      return responses.error(res, 404, 'Not Found', 'Subscription not found for organization')(
        new Error(`subscription not found for orgId=${orgId}`),
      );
    }

    const updated = await SubscriptionRepository.adminUpdatePlanOnly(String(existing._id), planId, adminUserId);

    logger.info('[billing.admin] plan bumped manually', {
      orgId,
      previousPlan: existing.plan,
      newPlan: planId,
      adminUserId,
      subscriptionId: String(existing._id),
    });

    return responses.success(res, 'subscription plan bumped')(updated);
  } catch (err) {
    return responses.error(res, 500, 'Internal Server Error', 'Failed to bump plan')(err);
  }
};

export default {
  adminRefundCharge,
  adminBumpPlan,
};
