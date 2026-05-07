/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import getStripe from '../lib/stripe.js';
import logger from '../../../lib/services/logger.js';
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';
import ProcessedStripeEventRepository from '../repositories/billing.processedStripeEvent.repository.js';
import OrganizationRepository from '../../organizations/repositories/organizations.repository.js';
import BillingExtraBalanceRepository from '../repositories/billing.extraBalance.repository.js';
import BillingWebhookService from './billing.webhook.service.js';

/**
 * Valid plan names from config (immutable set for O(1) lookups).
 */
const validPlans = new Set(config.billing?.plans || ['free', 'starter', 'pro', 'enterprise']);

/**
 * @function getCustomerStatus
 * @description Fetch the Stripe customer + subscription state alongside the DB subscription
 *              for side-by-side comparison (admin diagnostic endpoint).
 * @param {string} orgId - Organization ObjectId (string).
 * @returns {Promise<{db: Object|null, stripe: Object|null}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getCustomerStatus = async (orgId) => {
  if (!/^[0-9a-fA-F]{24}$/.test(orgId)) {
    throw Object.assign(new Error('invalid argument: orgId must be a valid ObjectId'), { status: 422 });
  }

  const db = await SubscriptionRepository.findByOrganization(orgId);

  let stripeData = null;
  const stripe = getStripe();
  if (stripe && db?.stripeCustomerId) {
    try {
      const customer = await stripe.customers.retrieve(db.stripeCustomerId, {
        expand: ['subscriptions'],
      });
      stripeData = {
        customerId: customer.id,
        email: customer.email,
        deleted: customer.deleted ?? false,
        subscriptions: customer.subscriptions?.data?.map((s) => ({
          id: s.id,
          status: s.status,
          currentPeriodEnd: s.current_period_end,
          cancelAtPeriodEnd: s.cancel_at_period_end,
          plan: s.items?.data?.[0]?.price?.metadata?.planId ?? null,
        })) ?? [],
      };
    } catch (err) {
      logger.error('[billing.admin] getCustomerStatus — Stripe fetch failed', {
        orgId,
        stripeCustomerId: db.stripeCustomerId,
        error: err?.message ?? String(err),
      });
      stripeData = { error: err?.message ?? String(err) };
    }
  }

  return { db, stripe: stripeData };
};

/**
 * @function syncOrgFromStripe
 * @description Force-sync a subscription from Stripe into the DB.
 *              Fetches the live Stripe subscription, validates the status, and updates the DB.
 *              Uses direct update (bypasses event-ordering guard) — this is an explicit admin override.
 * @param {string} orgId - Organization ObjectId (string).
 * @returns {Promise<{previous: Object, updated: Object}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const syncOrgFromStripe = async (orgId) => {
  if (!/^[0-9a-fA-F]{24}$/.test(orgId)) {
    throw Object.assign(new Error('invalid argument: orgId must be a valid ObjectId'), { status: 422 });
  }

  const existing = await SubscriptionRepository.findByOrganization(orgId);
  if (!existing) {
    throw Object.assign(new Error(`subscription not found for orgId=${orgId}`), { status: 404 });
  }
  if (!existing.stripeSubscriptionId) {
    throw Object.assign(new Error('subscription has no stripeSubscriptionId — cannot sync from Stripe'), { status: 422 });
  }

  const stripe = getStripe();
  if (!stripe) {
    throw Object.assign(new Error('Stripe is not configured'), { status: 502 });
  }

  const stripeSub = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId);
  const newPlan = resolveStripePlan(stripeSub);
  const newStatus = stripeSub.status;
  const newPeriodStart = stripeSub.current_period_start
    ? new Date(stripeSub.current_period_start * 1000)
    : null;

  const previous = { plan: existing.plan, status: existing.status };

  // Intentional: full Stripe-truth sync — writes status AND plan directly.
  // adminUpdatePlanOnly is for the UI plan-bump flow only (audit trail, no Stripe re-sync).
  const updated = await SubscriptionRepository.update({
    _id: existing._id,
    plan: newPlan,
    status: newStatus,
    ...(newPeriodStart ? { currentPeriodStart: newPeriodStart } : {}),
  });

  // Sync org plan field so quotas + access control reflect the new plan immediately.
  await OrganizationRepository.setPlan(orgId, newPlan);

  logger.info('[billing.admin] syncOrgFromStripe — synced', {
    orgId,
    previous,
    updated: { plan: newPlan, status: newStatus },
    stripeSubscriptionId: existing.stripeSubscriptionId,
  });

  return { previous, updated };
};

/**
 * @function replayWebhookEvent
 * @description Re-fetch a Stripe event by ID and re-dispatch it through the webhook handler.
 *              Deletes the processed-event record first so withIdempotency allows re-entry.
 *              Used to recover dead-lettered or failed events after the root cause is fixed.
 * @param {string} eventId - Stripe event ID (evt_xxx).
 * @returns {Promise<Object>} Dispatch result from BillingWebhookService.withIdempotency.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const replayWebhookEvent = async (eventId) => {
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    throw Object.assign(new Error('invalid argument: eventId must be a non-empty string'), { status: 422 });
  }

  const stripe = getStripe();
  if (!stripe) {
    throw Object.assign(new Error('Stripe is not configured'), { status: 502 });
  }

  // Fetch fresh event from Stripe
  let event;
  try {
    event = await stripe.events.retrieve(eventId);
  } catch (err) {
    throw Object.assign(
      new Error(`Stripe event fetch failed: ${err?.message ?? String(err)}`),
      { status: 502 },
    );
  }

  // Clear idempotency record so the handler can re-run (handles both normal + dead-letter states).
  // deleteByEventId returns { deleted: false } when not found — never throws — so no catch needed.
  await ProcessedStripeEventRepository.deleteByEventId(eventId);

  // Re-dispatch via the same switch used by the webhook controller
  const result = await dispatchWebhookEvent(event);

  logger.info('[billing.admin] replayWebhookEvent — dispatched', {
    eventId,
    eventType: event.type,
    result,
  });

  return { eventId, eventType: event.type, result };
};

/**
 * @function listDeadLetters
 * @description Paginated list of dead-lettered processed events.
 * @param {Object} [opts] - Pagination options (page, limit).
 * @returns {Promise<{items: Array, total: number, page: number, limit: number}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const listDeadLetters = (opts = {}) => ProcessedStripeEventRepository.listDeadLetters(opts);

/**
 * @function purgeDeadLetter
 * @description Permanently purge a dead-lettered event after manual investigation.
 *              Guards: only removes documents with deadLetter === true.
 * @param {string} eventId - Stripe event ID.
 * @returns {Promise<{purged: boolean}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const purgeDeadLetter = async (eventId) => {
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    throw Object.assign(new Error('invalid argument: eventId must be a non-empty string'), { status: 422 });
  }
  const result = await ProcessedStripeEventRepository.purgeDeadLetterByEventId(eventId);
  if (!result.purged) {
    throw Object.assign(
      new Error(`dead-letter event not found: ${eventId}`),
      { status: 404 },
    );
  }

  logger.info('[billing.admin] purgeDeadLetter — purged', { eventId });
  return result;
};

/**
 * @function cancelSubscription
 * @description Cancel a Stripe subscription and downgrade the DB to free/canceled.
 *              Decision #5: (a) cancel → (b) retrieve to verify status === 'canceled'
 *              → (c) DB write with confirmed status. Prevents drift on network timeout.
 * @param {string} orgId - Organization ObjectId (string).
 * @returns {Promise<{previous: Object, updated: Object, stripeStatus: string}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const cancelSubscription = async (orgId) => {
  if (!/^[0-9a-fA-F]{24}$/.test(orgId)) {
    throw Object.assign(new Error('invalid argument: orgId must be a valid ObjectId'), { status: 422 });
  }

  const existing = await SubscriptionRepository.findByOrganization(orgId);
  if (!existing) {
    throw Object.assign(new Error(`subscription not found for orgId=${orgId}`), { status: 404 });
  }
  if (!existing.stripeSubscriptionId) {
    throw Object.assign(new Error('subscription has no stripeSubscriptionId — cannot cancel via Stripe'), { status: 422 });
  }

  const stripe = getStripe();
  if (!stripe) {
    throw Object.assign(new Error('Stripe is not configured'), { status: 502 });
  }

  const previous = { plan: existing.plan, status: existing.status };

  // (a) Cancel on Stripe
  await stripe.subscriptions.cancel(existing.stripeSubscriptionId);

  // (b) Retrieve to verify (Decision #5 — avoid drift on network timeout)
  let confirmedStatus;
  try {
    const retrieved = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId);
    confirmedStatus = retrieved.status;
  } catch (err) {
    // Retrieve failed after cancel — treat as canceled (cancel was already requested).
    // Log the anomaly so ops can verify via Stripe Dashboard.
    logger.error('[billing.admin] cancelSubscription — post-cancel retrieve failed, assuming canceled', {
      orgId,
      stripeSubscriptionId: existing.stripeSubscriptionId,
      error: err?.message ?? String(err),
    });
    confirmedStatus = 'canceled';
  }

  if (confirmedStatus !== 'canceled') {
    logger.error('[billing.admin] cancelSubscription — unexpected status after cancel', {
      orgId,
      stripeSubscriptionId: existing.stripeSubscriptionId,
      confirmedStatus,
    });
    throw Object.assign(
      new Error(`Stripe subscription status after cancel is '${confirmedStatus}', expected 'canceled'`),
      { status: 502 },
    );
  }

  // (c) DB write with confirmed status
  const updated = await SubscriptionRepository.update({
    _id: existing._id,
    plan: 'free',
    status: 'canceled',
  });

  await OrganizationRepository.setPlan(orgId, 'free');

  logger.info('[billing.admin] cancelSubscription — canceled', {
    orgId,
    previous,
    stripeSubscriptionId: existing.stripeSubscriptionId,
    confirmedStatus,
  });

  return { previous, updated, stripeStatus: confirmedStatus };
};

/**
 * @function creditDisputeReinstated
 * @description Apply a manual extras-balance credit after Stripe rules in our favor on a dispute.
 *              When `charge.dispute.funds_reinstated` fires, the merchant gets the funds back,
 *              but the customer's meter units were already consumed. This endpoint lets ops
 *              restore the extras balance proportionally so the customer keeps their credit.
 *
 *              Idempotent: `refundRequestId` is used as the idempotency key so double-clicking
 *              the admin UI never produces a double credit.
 *
 *              Audit trail: logs adminUserId + chargeId + amountCents on every call.
 *
 * @param {string} chargeId - Stripe charge ID (ch_xxx) to correlate with the dispute.
 * @param {number} amountCents - Amount to credit in cents (positive integer). Converted to
 *                               meter units by a 1:1 mapping — callers should pass the
 *                               dispute amount or a proportion; the exact unit conversion
 *                               is owned by ops (they know the pack price per unit).
 * @param {string} reason - Ops note for audit trail (stored in ledger entry refId context).
 * @param {string} refundRequestId - UUID per click (idempotency key).
 * @param {string} orgId - Organization ObjectId (string) — whose extras balance to credit.
 * @param {string} adminUserId - Authenticated admin user ID for audit trail.
 * @returns {Promise<{applied: boolean, ledgerEntry: Object|null}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const creditDisputeReinstated = async (chargeId, amountCents, reason, refundRequestId, orgId, adminUserId) => {
  if (!/^[0-9a-fA-F]{24}$/.test(orgId)) {
    throw Object.assign(new Error('invalid argument: orgId must be a valid ObjectId'), { status: 422 });
  }
  if (typeof chargeId !== 'string' || !/^ch_/.test(chargeId)) {
    throw Object.assign(new Error('invalid argument: chargeId must start with ch_'), { status: 422 });
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw Object.assign(new Error('invalid argument: amountCents must be a positive integer'), { status: 422 });
  }
  if (typeof refundRequestId !== 'string' || refundRequestId.trim().length < 8) {
    throw Object.assign(new Error('invalid argument: refundRequestId must be at least 8 characters'), { status: 422 });
  }
  if (typeof reason !== 'string' || reason.trim().length < 3) {
    throw Object.assign(new Error('invalid argument: reason must be at least 3 characters'), { status: 422 });
  }

  // Idempotency key includes the refundRequestId to prevent double-click double-credit.
  const refId = `dispute-credit-${refundRequestId}`;

  // Credit the extras balance using the compensation path.
  // amountCents is used directly as the credit unit — ops chooses the proportional amount.
  const result = await BillingExtraBalanceRepository.creditCompensation(orgId, amountCents, refId, reason);

  logger.info('[billing.admin] creditDisputeReinstated — applied', {
    orgId,
    chargeId,
    amountCents,
    reason,
    refundRequestId,
    adminUserId,
    applied: result.applied,
    reason_for_skip: result.reason,
  });

  return {
    applied: result.applied,
    ledgerEntry: result.doc
      ? result.doc.ledger?.find((e) => e.refId === refId) ?? null
      : null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @function resolveStripePlan
 * @description Resolve the plan name from a Stripe subscription object.
 *              Same heuristic as billing.webhook.service.js (price.metadata.planId first).
 * @param {Object} subscription - Stripe subscription object.
 * @returns {string} plan name.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const resolveStripePlan = (subscription) => {
  const item = subscription.items?.data?.[0];
  const raw = item?.price?.metadata?.planId || item?.plan?.metadata?.planId;
  return validPlans.has(raw) ? raw : 'free';
};

/**
 * @function dispatchWebhookEvent
 * @description Route a raw Stripe event to the appropriate webhook handler.
 *              Mirrors the switch in billing.webhook.controller.js.
 * @param {Object} event - Stripe event object.
 * @returns {Promise<Object>} Handler result.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const dispatchWebhookEvent = (event) => {
  switch (event.type) {
    case 'checkout.session.completed':
      return BillingWebhookService.withIdempotency(event, (e) =>
        BillingWebhookService.handleCheckoutSessionCompleted(e),
      );
    case 'customer.subscription.created':
      return BillingWebhookService.withIdempotency(event, (e) =>
        BillingWebhookService.handleSubscriptionCreated(e.data.object, e),
      );
    case 'customer.subscription.updated':
      return BillingWebhookService.withIdempotency(event, (e) =>
        BillingWebhookService.handleSubscriptionUpdated(e.data.object, e),
      );
    case 'customer.subscription.deleted':
      return BillingWebhookService.withIdempotency(event, (e) =>
        BillingWebhookService.handleSubscriptionDeleted(e.data.object, e),
      );
    case 'invoice.payment_failed':
      return BillingWebhookService.withIdempotency(event, (e) =>
        BillingWebhookService.handleInvoicePaymentFailed(e.data.object, e),
      );
    case 'invoice.payment_succeeded':
      return BillingWebhookService.withIdempotency(event, (e) =>
        BillingWebhookService.handleInvoicePaymentSucceeded(e.data.object, e),
      );
    case 'charge.refunded':
      return BillingWebhookService.withIdempotency(event, (e) =>
        BillingWebhookService.handleChargeRefunded(e.data.object),
      );
    case 'customer.deleted':
      return BillingWebhookService.withIdempotency(event, (e) =>
        BillingWebhookService.handleCustomerDeleted(e.data.object, e),
      );
    case 'charge.dispute.created':
      return BillingWebhookService.withIdempotency(event, (e) =>
        BillingWebhookService.handleChargeDisputeCreated(e.data.object, e),
      );
    case 'charge.dispute.funds_withdrawn':
      return BillingWebhookService.withIdempotency(event, (e) =>
        BillingWebhookService.handleChargeDisputeFundsWithdrawn(e.data.object, e),
      );
    case 'charge.dispute.funds_reinstated':
      return BillingWebhookService.withIdempotency(event, (e) =>
        BillingWebhookService.handleChargeDisputeFundsReinstated(e.data.object, e),
      );
    default:
      logger.info('[billing.admin] replay — unhandled event type, no handler', { type: event.type, id: event.id });
      return Promise.resolve({ skipped: true, reason: 'unhandled_event_type' });
  }
};

export default {
  getCustomerStatus,
  syncOrgFromStripe,
  replayWebhookEvent,
  listDeadLetters,
  purgeDeadLetter,
  cancelSubscription,
  creditDisputeReinstated,
};
