/**
 * Module dependencies
 */
import responses from '../../../lib/helpers/responses.js';
import getStripe from '../lib/stripe.js';
import BillingAdminService from '../services/billing.admin.service.js';

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
    // Stripe invalid_request_error (e.g. refund > original amount) → surface as 422.
    // Other Stripe errors (network, auth) → 502.
    const isInvalidArg = err.message?.startsWith('invalid argument');
    const isStripeInvalidRequest = err.type === 'StripeInvalidRequestError' || err.code === 'charge_already_refunded' || err.type === 'invalid_request_error';
    const status = isInvalidArg || isStripeInvalidRequest ? 422 : 502;
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

    // Guard: req.user._id must be a valid ObjectId — the JWT middleware sets it, but a missing
    // or malformed token could leave it undefined, causing a Mongoose CastError downstream.
    const rawAdminId = req.user?._id;
    if (!rawAdminId) {
      return responses.error(res, 422, 'Unprocessable Entity', 'Failed to bump plan')(
        new Error('invalid argument: authenticated user id is missing'),
      );
    }
    const adminUserId = String(rawAdminId);

    // NOTE: this controller orchestrates directly against repo + logger to avoid adding a
    // dedicated service method for a single admin escape hatch. This is an intentional
    // exception to the service-layer convention: the operation is simple (find → update → sync),
    // has no domain logic beyond what the repo already provides, and extracting it into
    // billing.admin.service.js would add ceremony for no isolation benefit.
    // Tracked for refactor in a future service-extraction pass if more admin operations join.
    //
    // Lazy imports — the repo module references mongoose.model('Subscription') at load time,
    // and the logger module touches config.log.fileLogger which isn't always mocked. Unrelated
    // unit tests that mock Stripe but don't load full schemas would crash on top-level imports.
    const { default: SubscriptionRepository } = await import('../repositories/billing.subscription.repository.js');
    const { default: OrganizationRepository } = await import('../../organizations/repositories/organizations.repository.js');
    const { default: logger } = await import('../../../lib/services/logger.js');

    const existing = await SubscriptionRepository.findByOrganization(orgId);
    if (!existing) {
      return responses.error(res, 404, 'Not Found', 'Subscription not found for organization')(
        new Error(`subscription not found for orgId=${orgId}`),
      );
    }

    const updated = await SubscriptionRepository.adminUpdatePlanOnly(String(existing._id), planId, adminUserId);

    // Sync org plan so meter quotas / feature flags / access control reflect the bump
    // immediately. Without this the new plan only applies to the subscription doc, but
    // the organization's plan field — read by requirePlan / requireQuota — stays stale
    // until the next Stripe webhook (which may revert to Stripe's value).
    await OrganizationRepository.setPlan(orgId, planId);

    logger.info('[billing.admin] plan bumped manually', {
      orgId,
      previousPlan: existing.plan,
      newPlan: planId,
      adminUserId,
      subscriptionId: String(existing._id),
    });

    return responses.success(res, 'subscription plan bumped')(updated);
  } catch (err) {
    // Surface schema/validation errors from Mongoose as 422 instead of letting them fall to 500.
    if (err?.name === 'ValidationError' || err?.message?.startsWith('invalid argument')) {
      return responses.error(res, 422, 'Unprocessable Entity', 'Failed to bump plan')(err);
    }
    return responses.error(res, 500, 'Internal Server Error', 'Failed to bump plan')(err);
  }
};

/**
 * @desc GET /api/admin/billing/customer/:orgId
 *       Return Stripe customer state + DB subscription side-by-side.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const adminGetCustomerStatus = async (req, res) => {
  try {
    const { orgId } = req.params;
    const result = await BillingAdminService.getCustomerStatus(orgId);
    return responses.success(res, 'customer status')(result);
  } catch (err) {
    const status = err.status ?? 500;
    const title = status === 404 ? 'Not Found' : status === 422 ? 'Unprocessable Entity' : status === 502 ? 'Bad Gateway' : 'Internal Server Error';
    return responses.error(res, status, title, 'Failed to fetch customer status')(err);
  }
};

/**
 * @desc POST /api/admin/billing/sync/:orgId
 *       Force Stripe→DB sync for an organization's subscription.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const adminSyncFromStripe = async (req, res) => {
  try {
    const { orgId } = req.params;
    const result = await BillingAdminService.syncOrgFromStripe(orgId);
    return responses.success(res, 'subscription synced from Stripe')(result);
  } catch (err) {
    const status = err.status ?? 500;
    const title = status === 404 ? 'Not Found' : status === 422 ? 'Unprocessable Entity' : status === 502 ? 'Bad Gateway' : 'Internal Server Error';
    return responses.error(res, status, title, 'Failed to sync from Stripe')(err);
  }
};

/**
 * @desc POST /api/admin/billing/webhook/replay
 *       Re-fetch a Stripe event and re-dispatch it through webhook handlers.
 * @param {Object} req - Express request object (body: { eventId })
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const adminReplayWebhook = async (req, res) => {
  try {
    const { eventId } = req.body;
    const result = await BillingAdminService.replayWebhookEvent(eventId);
    return responses.success(res, 'webhook event replayed')(result);
  } catch (err) {
    const status = err.status ?? 500;
    const title = status === 404 ? 'Not Found' : status === 422 ? 'Unprocessable Entity' : status === 502 ? 'Bad Gateway' : 'Internal Server Error';
    return responses.error(res, status, title, 'Failed to replay webhook event')(err);
  }
};

/**
 * @desc GET /api/admin/billing/dead-letters
 *       Paginated list of dead-lettered processed Stripe events.
 * @param {Object} req - Express request object (query: { page, limit })
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const adminListDeadLetters = async (req, res) => {
  try {
    const { page, limit } = req.query;
    const result = await BillingAdminService.listDeadLetters({ page, limit });
    return responses.success(res, 'dead letters')(result);
  } catch (err) {
    return responses.error(res, 500, 'Internal Server Error', 'Failed to list dead letters')(err);
  }
};

/**
 * @desc DELETE /api/admin/billing/dead-letters/:eventId
 *       Permanently purge a dead-lettered event after manual investigation.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const adminPurgeDeadLetter = async (req, res) => {
  try {
    const { eventId } = req.params;
    const result = await BillingAdminService.purgeDeadLetter(eventId);
    return responses.success(res, 'dead letter purged')(result);
  } catch (err) {
    const status = err.status ?? 500;
    const title = status === 404 ? 'Not Found' : status === 422 ? 'Unprocessable Entity' : 'Internal Server Error';
    return responses.error(res, status, title, 'Failed to purge dead letter')(err);
  }
};

/**
 * @desc POST /api/admin/billing/cancel/:orgId
 *       Cancel Stripe subscription + downgrade DB to free/canceled.
 *       Decision #5: cancel → retrieve-verify → DB write.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const adminCancelSubscription = async (req, res) => {
  try {
    const { orgId } = req.params;
    const result = await BillingAdminService.cancelSubscription(orgId);
    return responses.success(res, 'subscription canceled')(result);
  } catch (err) {
    const status = err.status ?? 500;
    const title = status === 404 ? 'Not Found' : status === 422 ? 'Unprocessable Entity' : status === 502 ? 'Bad Gateway' : 'Internal Server Error';
    return responses.error(res, status, title, 'Failed to cancel subscription')(err);
  }
};

export default {
  adminRefundCharge,
  adminBumpPlan,
  adminGetCustomerStatus,
  adminSyncFromStripe,
  adminReplayWebhook,
  adminListDeadLetters,
  adminPurgeDeadLetter,
  adminCancelSubscription,
};
