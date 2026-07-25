/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import config from '../../../config/index.js';
import getStripe from '../lib/stripe.js';
import logger from '../../../lib/services/logger.js';
import SubscriptionRepository from '../repositories/billing.subscription.repository.js';
import ProcessedStripeEventRepository from '../repositories/billing.processedStripeEvent.repository.js';
import OrganizationRepository from '../../organizations/repositories/organizations.repository.js';
import BillingFailedBackfillRepository from '../repositories/billing.failedBackfill.repository.js';
import BillingExtraService from './billing.extra.service.js';
import BillingResetService from './billing.reset.service.js';
import billingEvents from '../lib/events.js';
import { SENTINEL_PENDING } from '../lib/billing.constants.js';
import { retryWithBackoff } from '../lib/billing.retry.js';
import { isNonTransientStripeError } from '../lib/billing.stripe-errors.js';
import { resolvePlanFromSubscription, lookupPlanByPriceId } from '../lib/billing.planResolver.js';
import AnalyticsService from '../../../lib/services/analytics.js';

/**
 * Treats a stripeSessionId as "unresolved" when absent, empty, or still the
 * creation-time sentinel placeholder written before Stripe assigned a real cs_* id.
 * Stripe Charge metadata is a one-time snapshot copied at charge creation — later
 * PaymentIntent metadata patches do NOT propagate back, so charge.metadata.stripeSessionId
 * may permanently carry SENTINEL_PENDING for any charge created during the brief window
 * between session.create and checkout.session.completed.
 * @param {string|undefined} id
 * @returns {boolean}
 */
const isUnresolved = (id) => !id || id === SENTINEL_PENDING;

/**
 * Maximum number of handler execution attempts before an event is dead-lettered.
 * After this many failures the claim is kept permanently so Stripe stops retrying.
 */
const BILLING_WEBHOOK_MAX_ATTEMPTS = 5;

/**
 * Valid plan names from config (immutable set for O(1) lookups).
 */
const validPlans = new Set(config.billing?.plans || ['free', 'starter', 'pro', 'enterprise']);

/**
 * @description Validate that a plan name is a known enum value.
 * @param {string} plan - The plan name to validate.
 * @returns {string|null} The plan name if valid, null otherwise.
 */
const validatePlan = (plan) => {
  if (validPlans.has(plan)) return plan;
  if (plan) logger.warn('[billing.webhook] validatePlan: unrecognized planId', { raw: plan, validPlans: [...validPlans] });
  return null;
};

/**
 * Plan rank lookup — higher index means higher-tier plan.
 * Used to determine upgrade vs downgrade.
 */
const planRanks = Object.fromEntries((config.billing?.plans || []).map((p, i) => [p, i]));

/**
 * @description Resolve the plan name from a Stripe subscription object for a webhook write path.
 * Delegates to the shared priceId→plan resolver (see `../lib/billing.planResolver.js`, also used
 * by the admin force-sync tool and the reconcile cron — #3964/#1250). Strategy (most-specific
 * first): config priceId map → price/plan.metadata.planId legacy fallback → unresolvable.
 *
 * On unresolvable (unmapped priceId AND no valid metadata.planId — e.g. a manually-sold
 * enterprise price, or a misconfigured `config.stripe.prices`), this does NOT force 'free'.
 * Unlike the admin tool (aborts the write with a 409) or the reconcile cron (skips the plan
 * comparison, log-only), a webhook cannot abort mid-flight — an event still needs a plan
 * written. Instead it retains `fallbackPlan` (the org/subscription's last-known plan, passed by
 * the caller from the already-loaded DB doc) so an ambiguous price never silently downgrades a
 * paying org, and emits an alert for manual review (mirrors the `billing.refund.unresolved`
 * alert pattern used elsewhere in this file). When `fallbackPlan` is itself unknown (no prior
 * plan reference — a genuinely brand-new subscription/org), defaults to 'free': the
 * least-harmful default for a fresh signup, an ops/config error either way, and still surfaced
 * via the alert (#3970).
 * @param {Object} subscription - Stripe subscription object
 * @param {string|null} [fallbackPlan] - Last-known plan to retain on ambiguity; null/undefined → 'free'.
 * @param {Object} [ctx={}] - Alert context merged into the log/emit payload (e.g. organizationId, eventId).
 * @returns {string} plan name
 */
const resolvePlan = (subscription, fallbackPlan = null, ctx = {}) => {
  const resolved = resolvePlanFromSubscription(subscription, { logPrefix: '[billing.webhook]' });
  if (resolved !== null) return resolved;

  const hadKnownPlan = fallbackPlan !== null && fallbackPlan !== undefined;
  const retainedPlan = hadKnownPlan ? fallbackPlan : 'free';
  const priceId = subscription?.items?.data?.[0]?.price?.id ?? null;

  logger.error(
    '[billing.webhook] resolvePlan — unresolvable price, NOT forcing free (retaining last-known plan)',
    { ...ctx, stripeSubscriptionId: subscription?.id, priceId, retainedPlan, hadKnownPlan },
  );
  try {
    billingEvents.emit('billing.webhook.plan_unresolved', {
      ...ctx,
      stripeSubscriptionId: subscription?.id,
      priceId,
      retainedPlan,
      hadKnownPlan,
    });
  } catch (evtErr) {
    logger.error('[billing.webhook] billing.webhook.plan_unresolved listener error (non-fatal)', {
      error: evtErr?.message ?? String(evtErr),
      stack: evtErr?.stack,
    });
  }
  return retainedPlan;
};

/**
 * @description Sync the organization plan field to match the subscription plan.
 *              Delegates to OrganizationRepository.setPlan to keep DB access in the repo layer.
 * @param {String} organizationId - Organization document ID
 * @param {String} plan - Plan name to set
 * @returns {Promise<void>}
 */
const syncOrganizationPlan = async (organizationId, plan) => {
  if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) return;
  await OrganizationRepository.setPlan(organizationId, plan);
};

/**
 * @description Wrap a webhook handler with idempotency using ProcessedStripeEvent.
 *
 * Atomic-claim semantics (closes TOCTOU race) + persistent retry counter:
 * 1. tryRecord atomically inserts the event record BEFORE running the handler.
 *    The unique index on eventId means only the first concurrent delivery succeeds.
 * 2. tryRecord uses 3-state semantics so attempts persists across Stripe redeliveries:
 *      - First delivery → { recorded: true, retry: false }              → handler runs
 *      - In-flight retry (attempts > 0, !deadLetter) → { recorded: true, retry: true } → handler runs again
 *      - Already succeeded (attempts === 0) → { recorded: false, reason: 'already_processed' } → skip
 *      - Dead-letter (deadLetter: true)     → { recorded: false, reason: 'dead_letter' }       → skip
 * 3. On handler exception we DO NOT delete the doc (the previous design did, which reset
 *    attempts to 0 on every Stripe redelivery and made BILLING_WEBHOOK_MAX_ATTEMPTS unreachable).
 *    Instead we increment attempts, then either:
 *      - attempts >= MAX → markDeadLetter, log critical, return success to Stripe (no throw)
 *      - attempts <  MAX → throw → Stripe gets 5xx → redelivers ~24h later → tryRecord returns
 *        { recorded: true, retry: true } → handler runs again, attempts persists.
 * 4. On handler success the record stays with attempts === 0 (we never increment on success),
 *    which is the terminal-success signal for tryRecord on subsequent redeliveries.
 *
 * @param {Object} event - Full Stripe event object (must have event.id and event.type).
 * @param {Function} handler - Async function (event) => result called when event is new or retrying.
 * @param {Object} [ctx={}] - Optional context passed from the controller layer.
 * @param {string} [ctx.requestId] - Express request ID for end-to-end traceability across log lines.
 * @returns {Promise<Object>} Handler result, or skip sentinel
 *          { skipped: true, reason: 'duplicate_event_or_dead_letter' }, or
 *          dead-letter sentinel { deadLettered: true, eventId, eventType, attempts }.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const withIdempotency = async (event, handler, { requestId } = {}) => {
  const eventId = event.id;
  const eventType = event.type;

  // Atomically claim or re-enter — see tryRecord for 3-state semantics.
  const claim = await ProcessedStripeEventRepository.tryRecord(eventId, eventType);
  if (!claim.recorded) {
    logger.info('[billing] webhook skipped', { eventId, eventType, reason: claim.reason, requestId });
    return { skipped: true, reason: 'duplicate_event_or_dead_letter', detail: claim.reason };
  }

  logger.info('[billing] webhook handler entry', { eventId, eventType, retry: claim.retry ?? false, requestId });
  try {
    return await handler(event);
  } catch (err) {
    // Increment attempt counter and record error details before deciding fate.
    // We MUST NOT delete the doc on failure — attempts must persist across Stripe redeliveries
    // for BILLING_WEBHOOK_MAX_ATTEMPTS to be reachable.
    let attempts = 1;
    try {
      const updated = await ProcessedStripeEventRepository.incrementAttempts(eventId, err);
      attempts = updated?.attempts ?? 1;
    } catch (counterErr) {
      logger.error('[billing] webhook attempts increment failed', { eventId, eventType, error: counterErr?.message, requestId });
    }

    if (attempts >= BILLING_WEBHOOK_MAX_ATTEMPTS) {
      // Dead-letter: keep claim permanently with deadLetter=true so subsequent redeliveries skip.
      try {
        await ProcessedStripeEventRepository.markDeadLetter(eventId);
      } catch (dlErr) {
        logger.error('[billing] webhook markDeadLetter failed', { eventId, eventType, error: dlErr?.message, requestId });
      }
      logger.error('[billing] webhook dead-letter', { eventId, eventType, attempts, error: err?.message ?? String(err), stack: err?.stack, requestId });
      // Return success to Stripe so it stops retrying.
      return { deadLettered: true, eventId, eventType, attempts };
    }

    // Below MAX: keep the doc (attempts persists), throw so Stripe retries on next delivery.
    // The next delivery will hit tryRecord → { recorded: true, retry: true } and re-enter here.
    logger.error('[billing] webhook handler failed, will retry', { eventId, eventType, attempts, error: err?.message ?? String(err), requestId });
    throw err;
  }
};

/**
 * @description Handle checkout.session.completed event — route by session.mode.
 *       mode='subscription' → handleCheckoutCompleted (plan subscription activation).
 *       mode='payment'      → handleCheckoutPaymentCompleted (extras pack credit).
 * @param {Object} event - Full Stripe event (data.object is the session)
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleCheckoutSessionCompleted = async (event) => {
  const session = event.data.object;
  if (session.mode === 'payment') {
    return handleCheckoutPaymentCompleted(session);
  }
  return handleCheckoutCompleted(session, event);
};

/**
 * @description Handle checkout.session.completed for mode='subscription' — create or update subscription.
 *              - Fetches real subscription status from Stripe (avoids hardcoding 'active' which is wrong
 *                for trialing subscriptions).
 *              - Uses updateIfEventNewer for existing rows so concurrent webhooks/admin updates don't race.
 *              - On race with subscription.updated arriving first, that handler returns early because
 *                the row doesn't exist yet, then checkout creates the row with markers seeded.
 * @param {Object} session - Stripe checkout session object
 * @param {Object} event - Full Stripe event (for event-ordering guard)
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleCheckoutCompleted = async (session, event) => {
  const { customer: stripeCustomerId, subscription: stripeSubscriptionId, metadata } = session;
  let organizationId = metadata?.organizationId;
  const plan = validatePlan(metadata?.plan) || 'free';

  // Fallback: resolve organizationId from stripeCustomerId if metadata is missing
  if (!organizationId) {
    const sub = await SubscriptionRepository.findByStripeCustomerId(stripeCustomerId);
    if (sub) organizationId = String(sub.organization?._id || sub.organization);
  }

  if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) return;
  if (!stripeSubscriptionId) {
    logger.warn('[billing.webhook] checkout.session.completed in mode=subscription without subscription id', {
      sessionId: session?.id,
      organizationId,
    });
    return;
  }

  // Fetch real status from Stripe — never assume 'active' (could be 'trialing', 'incomplete', etc.)
  // On retrieval failure we abort: persisting 'active' on a failed fetch would silently
  // misclassify trialing/incomplete subscriptions and bypass dunning. The next webhook
  // (subscription.updated or invoice.payment_failed) will reconcile the correct status.
  const stripe = getStripe();
  if (!stripe) {
    logger.error('[billing.webhook] checkout.session.completed — Stripe not configured, aborting', {
      stripeSubscriptionId,
    });
    return;
  }
  let realStatus;
  try {
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    realStatus = sub?.status;
    if (!realStatus) {
      logger.error('[billing.webhook] checkout.session.completed — subscription has no status, aborting', {
        stripeSubscriptionId,
      });
      return;
    }
  } catch (err) {
    logger.error('[billing.webhook] checkout.session.completed — subscription retrieve failed, aborting to avoid stale active assumption', {
      stripeSubscriptionId,
      error: err?.message ?? String(err),
    });
    return;
  }

  const existing = await SubscriptionRepository.findByOrganization(organizationId);
  if (existing) {
    // Existing row → use event-ordering guard. Prevents a stale checkout event arriving after
    // a fresh subscription.updated from overwriting state.
    const fields = {
      stripeCustomerId,
      stripeSubscriptionId,
      plan,
      status: realStatus,
    };
    const updated = await SubscriptionRepository.updateIfEventNewer(
      String(existing._id),
      event.created,
      event.id,
      fields,
      'subscription',
    );
    if (!updated) {
      logger.info('[billing.webhook] skipped stale checkout.session.completed', { eventId: event.id });
      return;
    }
  } else {
    // New row → create with markers seeded so subsequent stale events are rejected.
    await SubscriptionRepository.create({
      organization: organizationId,
      stripeCustomerId,
      stripeSubscriptionId,
      plan,
      status: realStatus,
      lastSubscriptionEventCreatedAt: event.created,
      lastSubscriptionEventId: event.id,
    });
  }

  await syncOrganizationPlan(organizationId, plan);

  // Checkout activation can land mid-week on a pre-existing week doc (created earlier under
  // the prior plan) — refresh the stored quota snapshot so it stays honest for reconcile/
  // display-fallback. Non-fatal: usage attribution itself reads the live quota
  // (billing.usage.service.js), so a failure here does not misprice usage, only the snapshot.
  try {
    await BillingResetService.forceRotateForPlanChange(organizationId, { preserveUsage: true });
  } catch (err) {
    logger.warn('[billing.webhook] forceRotateForPlanChange failed after checkout.session.completed', {
      organizationId,
      error: err?.message ?? String(err),
    });
  }
};

/**
 * @description Handle checkout.session.completed for mode='payment' — credit extras pack.
 *       Extracts organizationId, packId, kind from session metadata.
 *       Skips silently if payment_status !== 'paid', kind !== 'extras', or metadata is incomplete.
 *       Backfills PaymentIntent metadata with the real cs_* session ID so that
 *       charge.refunded events can correlate the charge back to the correct ledger entry.
 *       At session creation time stripeSessionId is set to SENTINEL_PENDING (Stripe forbids
 *       self-reference). Charge.metadata is a one-time snapshot, so the PI patch is best-effort;
 *       handleChargeRefunded has a backfill resolver as a secondary defence.
 * @param {Object} session - Stripe checkout session object (mode='payment')
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleCheckoutPaymentCompleted = async (session) => {
  if (session.payment_status !== 'paid') return;

  const { metadata, id: stripeSessionId, payment_intent: paymentIntentId } = session;
  const { organizationId, packId, kind } = metadata ?? {};

  if (kind !== 'extras') return;
  if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) return;
  if (!packId) return;

  const result = await BillingExtraService.creditPack(organizationId, packId, stripeSessionId);

  // Observability: log when creditPack returns applied=false (duplicate session detected).
  // Debug level — not an error, but useful to detect phantom Stripe redeliveries in prod.
  if (result && !result.applied) {
    logger.debug('[billing.webhook] creditPack duplicate session detected — idempotency guard fired', {
      organizationId,
      packId,
      stripeSessionId,
    });
  }

  // Backfill PaymentIntent metadata with the real session ID so that charge.refunded
  // events can correlate the charge back to this ledger entry.
  // At session.create time stripeSessionId was set to SENTINEL_PENDING (Stripe forbids
  // self-reference). Propagating the real cs_* ID here ensures charge.metadata carries
  // it when a refund is issued later.
  if (paymentIntentId) {
    const stripe = getStripe();
    if (stripe) {
      try {
        await retryWithBackoff(
          () =>
            stripe.paymentIntents.update(paymentIntentId, {
              metadata: {
                organizationId,
                packId,
                kind: 'extras',
                stripeSessionId, // real cs_* ID (replaces SENTINEL_PENDING)
              },
            }),
          {
            attempts: 3,
            baseMs: 200,
            // Skip retries on deterministic Stripe errors (invalid request / auth / permission) —
            // they never succeed on retry and only delay the dead-letter path. See billing.stripe-errors.js.
            shouldRetry: (err) => !isNonTransientStripeError(err),
          },
        );
      } catch (err) {
        logger.error(
          '[billing.webhook] PI metadata backfill failed (retries exhausted or skipped) — refund correlation at risk',
          { paymentIntentId, stripeSessionId, error: err?.message ?? String(err), stack: err?.stack },
        );
        try {
          await BillingFailedBackfillRepository.record({
            paymentIntentId,
            stripeSessionId,
            error: err?.message ?? String(err),
            failedAt: new Date(),
          });
        } catch (dlqErr) {
          logger.error(
            '[billing.webhook] dead-letter write failed — manual reconciliation required',
            { paymentIntentId, stripeSessionId, error: dlqErr?.message ?? String(dlqErr), stack: dlqErr?.stack },
          );
        }
      }
    }
  }
};

/**
 * @description Handle customer.subscription.updated event — sync subscription state.
 *       Also triggers resetWeek when current_period_start changes (billing period renewal).
 * @param {Object} subscription - Stripe subscription object
 * @param {Object} event - Full Stripe event (with data.previous_attributes for plan/period change detection)
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleSubscriptionUpdated = async (subscription, event) => {
  const existing = await SubscriptionRepository.findByStripeSubscriptionId(subscription.id);
  if (!existing) return;

  // Hoisted so both resolvePlan's alert context and the rest of the handler share one value.
  const organizationId = String(existing.organization?._id || existing.organization);

  const newPlan = resolvePlan(subscription, existing.plan, { organizationId, eventId: event?.id });
  // Stripe API ≥ 2025-08-27 moved current_period_start/end to items.data[0].
  // Read from items first, fall back to top-level for older API versions.
  const rawPeriodStart = subscription.items?.data?.[0]?.current_period_start ?? subscription.current_period_start;
  const newPeriodStart = rawPeriodStart
    ? new Date(rawPeriodStart * 1000)
    : undefined;

  // Stripe `incomplete_expired` is a status (not a separate event type) — it fires when
  // the initial payment fails and the subscription is auto-cancelled by Stripe after ~24h.
  // Treat it as a downgrade-to-free + signal the org so they can retry.
  const isIncompleteExpired = subscription.status === 'incomplete_expired';
  const effectivePlan = isIncompleteExpired ? 'free' : newPlan;

  const fields = {
    plan: effectivePlan,
    status: subscription.status,
  };
  if (newPeriodStart) fields.currentPeriodStart = newPeriodStart;
  // Pending cancellation — record cancel_at_period_end flag and cancel_at date
  // so the UI can show the user when their plan actually ends instead of treating
  // it as an immediate downgrade. Does NOT change `plan` — subscription stays on
  // the current plan until cancel_at.
  if (typeof subscription.cancel_at_period_end === 'boolean') {
    fields.cancelAtPeriodEnd = subscription.cancel_at_period_end;
  }
  if (typeof subscription.cancel_at === 'number') {
    fields.cancelAt = new Date(subscription.cancel_at * 1000);
  } else if (subscription.cancel_at === null) {
    fields.cancelAt = null;
  }

  const updated = await SubscriptionRepository.updateIfEventNewer(String(existing._id), event.created, event.id, fields, 'subscription');
  if (!updated) {
    logger.info('[billing.webhook] skipped stale event', { eventId: event.id, type: event.type });
    return;
  }

  await syncOrganizationPlan(organizationId, effectivePlan);

  if (isIncompleteExpired) {
    logger.info('[billing.webhook] subscription incomplete_expired — downgraded to free', {
      organizationId,
      stripeSubscriptionId: subscription.id,
      eventId: event?.id,
    });
    try {
      billingEvents.emit('billing.subscription.expired', { organizationId, stripeSubscriptionId: subscription.id });
    } catch (evtErr) {
      logger.error('[billing.webhook] billing.subscription.expired listener error (non-fatal)', {
        error: evtErr?.message ?? String(evtErr),
        stack: evtErr?.stack,
      });
    }
  }

  // Hoist previousPeriodStart so it is accessible both in the plan-change block
  // (anchor computation) and in the standalone period-start-change block below.
  // Stripe API ≥ 2025-08-27 moved current_period_start to items.data[0]; fall back to top-level.
  const previousPeriodStart =
    event?.data?.previous_attributes?.items?.data?.[0]?.current_period_start
    ?? event?.data?.previous_attributes?.current_period_start;

  // Detect plan change from previous_attributes and emit event + trigger meter reset
  const previousItems = event?.data?.previous_attributes?.items?.data;
  let planChangeResetTriggered = false;
  if (previousItems) {
    const previousPriceId = previousItems[0]?.price?.id;
    const previousRaw = lookupPlanByPriceId(previousPriceId)
      || previousItems[0]?.price?.metadata?.planId
      || previousItems[0]?.plan?.metadata?.planId
      || null;
    // Validate against the canonical plan enum — legacy metadata can carry stale or invalid
    // values that would otherwise emit plan.changed + trigger forceRotateForPlanChange with junk.
    const previousPlan = validatePlan(previousRaw);
    if (previousPlan && previousPlan !== newPlan) {
      const prevRank = planRanks[previousPlan];
      const newRank = planRanks[newPlan];
      const isDowngrade = prevRank != null && newRank != null ? prevRank > newRank : null;
      try {
        billingEvents.emit('plan.changed', {
          organizationId,
          previousPlan,
          newPlan,
          subscription,
          isDowngrade,
        });
      } catch (evtErr) {
        // Listener errors must not disrupt webhook processing — log for traceability
        logger.error('[billing.webhook] plan.changed listener error (non-fatal)', {
          error: evtErr?.message ?? String(evtErr),
          stack: evtErr?.stack,
        });
      }

      // Emit analytics observability event for downstreams running PostHog (no-op otherwise).
      // Mirrors the internal plan.changed event but lands in the analytics pipeline.
      // AnalyticsService.capture() swallows its own errors — no outer try/catch needed.
      if (AnalyticsService.isConfigured()) {
        AnalyticsService.capture({
          distinctId: organizationId,
          event: 'subscription_changed',
          source: 'stripe-webhook',
          properties: {
            previousPlan,
            newPlan,
            isDowngrade,
          },
        });
      }

      // Plan switch mid-cycle = refresh the active week snapshot to the new plan.
      // Unlike cron-driven resetWeek, this preserves meterUsed by default so a plan
      // change does not refund or double-charge already attributed usage.
      // Only mark planChangeResetTriggered when the period did NOT also change:
      // when period AND plan change simultaneously (e.g. annual→monthly on renewal),
      // resetWeek(newPeriodStart) must still run to archive the old week.
      const periodAlsoChanged =
        previousPeriodStart !== undefined &&
        rawPeriodStart !== previousPeriodStart &&
        newPeriodStart;
      planChangeResetTriggered = !periodAlsoChanged;
      try {
        await BillingResetService.forceRotateForPlanChange(organizationId, { preserveUsage: true });
      } catch (err) {
        planChangeResetTriggered = false;
        logger.error('[billing.webhook] forceRotateForPlanChange failed, falling back to resetWeek', {
          error: err?.message ?? String(err),
          stack: err?.stack,
        });
      }
    }
  }

  // Detect period start change — trigger weekly meter reset (only when not already triggered by plan change).
  // Also runs when plan changed AND period changed simultaneously: forceRotateForPlanChange refreshes the
  // snapshot but does not archive the old week; resetWeek handles the week rollover.
  if (
    !planChangeResetTriggered &&
    previousPeriodStart !== undefined &&
    rawPeriodStart !== previousPeriodStart &&
    newPeriodStart
  ) {
    try {
      await BillingResetService.resetWeek(organizationId, newPeriodStart);
    } catch (err) {
      // Log for monitoring — not thrown so webhook processing continues
      logger.error('[billing.webhook] resetWeek failed (non-fatal)', {
        error: err?.message ?? String(err),
        stack: err?.stack,
      });
    }
  }
};

/**
 * @description Handle customer.subscription.deleted event — cancel subscription
 * @param {Object} subscription - Stripe subscription object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleSubscriptionDeleted = async (subscription, event) => {
  const existing = await SubscriptionRepository.findByStripeSubscriptionId(subscription.id);
  if (!existing) return;

  const updated = await SubscriptionRepository.updateIfEventNewer(String(existing._id), event.created, event.id, {
    plan: 'free',
    status: 'canceled',
  }, 'subscription');
  if (!updated) {
    logger.info('[billing.webhook] skipped stale event', { eventId: event.id, type: event.type });
    return;
  }

  const organizationId = String(existing.organization?._id || existing.organization);
  await syncOrganizationPlan(organizationId, 'free');

  // Force reset meter to free quota — canceled sub must not retain paid-plan snapshot units.
  try {
    await BillingResetService.forceRotateForPlanChange(organizationId, { preserveUsage: false });
  } catch (err) {
    // Log for monitoring — not thrown so webhook processing continues
    logger.error('[billing.webhook] forceRotateForPlanChange on cancel failed (non-fatal)', {
      error: err?.message ?? String(err),
      stack: err?.stack,
    });
  }
};

/**
 * @description Handle invoice.payment_failed event — mark subscription as past_due.
 *              Sets pastDueSince = now only when not already set (idempotent: multiple
 *              failed invoices do not reset the grace-period clock).
 *              Emits 'payment.failed' so downstream listeners can react (e.g. notifications).
 * @param {Object} invoice - Stripe invoice object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleInvoicePaymentFailed = async (invoice, event) => {
  const { subscription: stripeSubscriptionId } = invoice;
  if (!stripeSubscriptionId) return;

  const existing = await SubscriptionRepository.findByStripeSubscriptionId(stripeSubscriptionId);
  if (!existing) return;

  const fields = { status: 'past_due' };

  // Only set pastDueSince on first failure — do not reset the grace-period clock on retries.
  if (existing.pastDueSince == null) {
    fields.pastDueSince = new Date();
  }

  const updated = await SubscriptionRepository.updateIfEventNewer(String(existing._id), event.created, event.id, fields, 'invoice');
  if (!updated) {
    logger.info('[billing.webhook] skipped stale event', { eventId: event.id, type: event.type });
    return;
  }

  const organizationId = String(existing.organization?._id || existing.organization);
  try {
    billingEvents.emit('payment.failed', { organizationId });
  } catch (evtErr) {
    // Listener errors must not disrupt webhook processing — log for traceability
    logger.error('[billing.webhook] payment.failed listener error (non-fatal)', {
      error: evtErr?.message ?? String(evtErr),
      stack: evtErr?.stack,
    });
  }
};

/**
 * @description Handle invoice.payment_succeeded event — clear degraded mode and restore plan.
 *       When a past-due invoice is finally paid, remove the pastDueSince marker so
 *       the subscription exits degraded mode on next request.
 *       V8 C1: also re-fetches the live Stripe subscription to restore the correct plan,
 *       guarding against the case where customer.subscription.updated is dead-lettered
 *       after a dunning sweep downgraded the plan to 'free'. Stripe re-fetch failure is
 *       non-fatal (warn log, plan not restored, pastDueSince+status update still fires).
 *       Uses updateIfEventNewer to guard against out-of-order webhook delivery (V5 P1 #1).
 * @param {Object} invoice - Stripe invoice object
 * @param {Object} event - Full Stripe event (with event.created and event.id for ordering)
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleInvoicePaymentSucceeded = async (invoice, event) => {
  const { subscription: stripeSubscriptionId } = invoice;
  if (!stripeSubscriptionId) return;

  const existing = await SubscriptionRepository.findByStripeSubscriptionId(stripeSubscriptionId);
  if (!existing) return;

  // Always advance the invoice-family marker (lastInvoiceEventCreatedAt / lastInvoiceEventId)
  // so stale replays of older invoice events are correctly rejected by the ordering guard.
  //
  // For healthy subs (pastDueSince == null): pass empty fields — the marker-only $set is
  // cheap (no runValidators on user-facing fields) and guards the invoice ordering window.
  //
  // For past-due subs: include pastDueSince + status so the sub exits degraded mode.
  // V8 C1: also restore the plan from Stripe so a dunning-downgraded sub is fully recovered
  // even when customer.subscription.updated is dead-lettered.
  const isPastDue = existing.pastDueSince !== null && existing.pastDueSince !== undefined;
  const fields = isPastDue ? { pastDueSince: null, status: 'active' } : {};

  // Hoisted so both resolvePlan's alert context and the rest of the handler share one value.
  const organizationId = String(existing.organization?._id || existing.organization);

  let resolvedPlan = null;
  if (isPastDue) {
    try {
      const stripe = getStripe();
      if (!stripe) throw new Error('Stripe not configured');
      const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      // Restore path: an unresolvable price here must NOT re-write 'free' over a dunning-downgraded
      // sub — retain existing.plan (the last-known plan) and alert instead (#3970).
      resolvedPlan = resolvePlan(stripeSub, existing.plan, { organizationId, stripeSubscriptionId, eventId: event?.id });
      fields.plan = resolvedPlan;
    } catch (stripeErr) {
      logger.warn('[billing.webhook] invoice.payment_succeeded — Stripe re-fetch failed, plan not restored', {
        stripeSubscriptionId,
        error: stripeErr?.message ?? String(stripeErr),
      });
    }
  }

  const updated = await SubscriptionRepository.updateIfEventNewer(
    String(existing._id),
    event.created,
    event.id,
    fields,
    'invoice',
  );
  if (!updated) {
    logger.info('[billing.webhook] skipped stale event', { eventId: event.id, type: event.type });
    return;
  }

  if (isPastDue && resolvedPlan) {
    try {
      await syncOrganizationPlan(organizationId, resolvedPlan);
    } catch (syncErr) {
      logger.error('[billing.webhook] syncOrganizationPlan failed (non-fatal)', {
        organizationId,
        error: syncErr?.message ?? String(syncErr),
        stack: syncErr?.stack,
      });
      try {
        billingEvents.emit('billing.organization.sync_failed', { organizationId, source: 'dunning_recovery' });
      } catch (evtErr) {
        logger.error('[billing.webhook] billing.organization.sync_failed listener error (non-fatal)', {
          error: evtErr?.message ?? String(evtErr),
          stack: evtErr?.stack,
        });
      }
    }
  }
};

/**
 * @description Handle charge.refunded event — debit ledger proportionally.
 *       Reads charge.metadata.{organizationId, stripeSessionId, packId} which must be propagated
 *       via the upstream session creation pattern:
 *         stripe.checkout.sessions.create({
 *           ...,
 *           metadata: { organizationId, stripeSessionId, packId, ... },
 *           payment_intent_data: { metadata: { organizationId, stripeSessionId, packId, ... } },
 *         })
 *       Without payment_intent_data.metadata, charge.metadata will be empty and refunds
 *       silently skip. The downstream consumer is responsible for setting these at session creation.
 *       Calls BillingExtraService.refundPartial for each entry in charge.refunds.data.
 *       Each refund's rf_ id is used as the idempotency key, making webhook replay safe.
 *       Individual entries are silently skipped when: metadata is incomplete, refund amount
 *       is absent/zero, or the refund object has no id.
 *
 *       SENTINEL handling: at session.create time stripeSessionId is set to SENTINEL_PENDING
 *       ('__pending__'). Stripe Charge metadata is a one-time snapshot — even though
 *       checkout.session.completed patches the PaymentIntent with the real cs_* id,
 *       charge.metadata.stripeSessionId may permanently carry SENTINEL_PENDING.
 *       Both absent AND sentinel values trigger the PI backfill resolver path.
 * @param {Object} charge - Stripe charge object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleChargeRefunded = async (charge) => {
  const { metadata, payment_intent: paymentIntentId } = charge;

  // The session ID and organizationId must have been stamped on charge metadata
  // via payment_intent_data.metadata at session creation (not automatic — caller must set both
  // session.metadata and payment_intent_data.metadata explicitly).
  let { organizationId, stripeSessionId, packId } = metadata ?? {};

  if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) return;

  // Backfill resolver: if stripeSessionId is missing OR carries SENTINEL_PENDING,
  // fetch the PaymentIntent to find the real session ID patched by checkout.session.completed.
  // isUnresolved() treats both falsy values and the sentinel string as "unresolved".
  if (isUnresolved(stripeSessionId) && paymentIntentId) {
    const stripe = getStripe();
    if (stripe) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        stripeSessionId = paymentIntent.metadata?.stripeSessionId;
        // Also pick up packId from PI metadata if not in charge metadata
        if (!packId) packId = paymentIntent.metadata?.packId;
        if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) {
          const piOrgId = paymentIntent.metadata?.organizationId;
          if (piOrgId && mongoose.Types.ObjectId.isValid(piOrgId)) {
            organizationId = piOrgId;
          }
        }
      } catch (err) {
        logger.error('[billing] refund PI fetch failed', {
          chargeId: charge.id,
          paymentIntentId,
          error: err?.message ?? String(err),
          stack: err?.stack,
        });
      }
    }
  }

  if (isUnresolved(stripeSessionId)) {
    // Could not resolve stripeSessionId from charge or PaymentIntent metadata.
    // Emit alert event and log for manual reconciliation.
    const refundAmount = charge.refunds?.data?.reduce((sum, r) => sum + (r.amount ?? 0), 0) ?? 0;
    logger.error('[billing] refund unresolved — manual reconciliation required', {
      chargeId: charge.id,
      paymentIntentId,
      refundAmount,
    });
    try {
      billingEvents.emit('billing.refund.unresolved', { chargeId: charge.id, paymentIntentId, refundAmount });
    } catch (evtErr) {
      logger.error('[billing.webhook] billing.refund.unresolved listener error (non-fatal)', {
        error: evtErr?.message ?? String(evtErr),
        stack: evtErr?.stack,
      });
    }
    return;
  }

  // Process every refund in the list — each has a globally-unique rf_ id used as the idempotency
  // key, so re-processing on webhook replay or redelivery is safe (duplicate calls are no-ops).
  const refunds = Array.isArray(charge.refunds?.data) ? charge.refunds.data : [];
  for (const refund of refunds) {
    const { id: stripeRefundId, amount: refundAmount } = refund ?? {};
    if (!stripeRefundId || !refundAmount || refundAmount <= 0) continue;
    // Service layer computes proportional refundUnits from config.billing.packs.
    await BillingExtraService.refundPartial(organizationId, stripeSessionId, refundAmount, packId, stripeRefundId);
  }
};

/**
 * @description Handle customer.deleted event — null out Stripe customer/subscription refs.
 *       Triggered when an admin deletes a customer in the Stripe dashboard. If we keep the
 *       stale stripeCustomerId in our DB, the next _ensureStripeCustomer / checkout call
 *       will hit "No such customer" and crash the user's checkout flow.
 *
 *       Conservative recovery:
 *         1. Find the subscription by Stripe customer id.
 *         2. Null out stripeCustomerId + stripeSubscriptionId, force plan='free' / status='canceled'.
 *         3. Sync organization plan to free.
 *         4. Force meter rotation so the org no longer carries the paid quota snapshot.
 *
 *       No-op when no matching subscription exists in our DB (deletion of a customer we never
 *       provisioned, or already cleaned up).
 * @param {Object} customer - Stripe customer object (data.object of customer.deleted event).
 * @param {Object} event - Full Stripe event (for ordering / event-newer guard).
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleCustomerDeleted = async (customer, event) => {
  const stripeCustomerId = customer?.id;
  if (!stripeCustomerId) return;

  const existing = await SubscriptionRepository.findByStripeCustomerId(stripeCustomerId);
  if (!existing) return;

  const updated = await SubscriptionRepository.updateIfEventNewer(
    String(existing._id),
    event.created,
    event.id,
    {
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      plan: 'free',
      status: 'canceled',
    },
    'subscription',
  );
  if (!updated) {
    logger.info('[billing.webhook] skipped stale event', { eventId: event.id, type: event.type });
    return;
  }

  const organizationId = String(existing.organization?._id || existing.organization);
  await syncOrganizationPlan(organizationId, 'free');

  // Force meter reset so the cancelled org no longer retains a paid-plan snapshot.
  try {
    await BillingResetService.forceRotateForPlanChange(organizationId, { preserveUsage: false });
  } catch (err) {
    logger.error('[billing.webhook] forceRotateForPlanChange on customer.deleted failed (non-fatal)', {
      organizationId,
      error: err?.message ?? String(err),
      stack: err?.stack,
    });
  }
};

/**
 * @description Handle charge.dispute.created event — log + emit (no auto-debit).
 *       Triggered when a cardholder files a chargeback. Stripe will eventually debit the
 *       merchant bank account, but disputes are often won by the merchant (~50% are user
 *       error / "I don't recognise this charge"). Aggressive auto-debit on dispute opening
 *       would punish customers who are filing legitimate disputes that we eventually win.
 *
 *       Conservative policy: emit a `billing.dispute.opened` event for downstream listeners
 *       (admin notifications) and log a critical alert. Real claw-back happens later via
 *       `charge.dispute.funds_withdrawn` (when the dispute is lost) or `charge.refunded`
 *       (when we choose to refund), both of which already debit the ledger via
 *       handleChargeRefunded / refundPartial.
 *
 *       Resolves organizationId via charge metadata first, then falls back to the
 *       PaymentIntent metadata patched by handleCheckoutPaymentCompleted.
 * @param {Object} dispute - Stripe dispute object (data.object of charge.dispute.created).
 * @param {Object} event - Full Stripe event.
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleChargeDisputeCreated = async (dispute, event) => {
  const chargeId = dispute?.charge;
  const disputeId = dispute?.id;
  const amount = dispute?.amount ?? 0;
  const reason = dispute?.reason ?? null;

  let organizationId = null;
  let stripeSessionId = null;
  let paymentIntentId = null;

  // Best-effort: fetch charge → resolve org via charge or PaymentIntent metadata
  // (mirrors the resolver pattern in handleChargeRefunded).
  if (chargeId) {
    const stripe = getStripe();
    if (stripe) {
      try {
        const charge = await stripe.charges.retrieve(chargeId);
        const meta = charge?.metadata ?? {};
        organizationId = meta.organizationId ?? null;
        stripeSessionId = meta.stripeSessionId ?? null;
        paymentIntentId = charge?.payment_intent ?? null;

        if ((!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) && paymentIntentId) {
          const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
          const piMeta = paymentIntent?.metadata ?? {};
          if (!organizationId && piMeta.organizationId && mongoose.Types.ObjectId.isValid(piMeta.organizationId)) {
            organizationId = piMeta.organizationId;
          }
          if (!stripeSessionId) stripeSessionId = piMeta.stripeSessionId ?? null;
        }
      } catch (err) {
        logger.error('[billing.webhook] dispute charge/PI fetch failed', {
          chargeId,
          disputeId,
          error: err?.message ?? String(err),
          stack: err?.stack,
        });
      }
    }
  }

  // Critical alert — ops MUST react manually (decide to fight or accept the dispute).
  // No auto-debit: real claw-back happens on charge.dispute.funds_withdrawn / charge.refunded.
  logger.error('[billing] dispute opened — manual review required', {
    disputeId,
    chargeId,
    organizationId,
    stripeSessionId,
    amount,
    reason,
    eventId: event?.id,
  });

  try {
    billingEvents.emit('billing.dispute.opened', {
      disputeId,
      chargeId,
      organizationId,
      stripeSessionId,
      amount,
      reason,
    });
  } catch (evtErr) {
    // Listener errors must not break webhook processing — log for traceability.
    logger.error('[billing.webhook] billing.dispute.opened listener error (non-fatal)', {
      error: evtErr?.message ?? String(evtErr),
      stack: evtErr?.stack,
    });
  }
};

/**
 * @description Handle charge.dispute.funds_withdrawn event — debit ledger (dispute lost).
 *       Triggered by Stripe when funds are actually withdrawn from the merchant bank account
 *       because the dispute was lost (or accepted). At this point the customer kept their
 *       meter units but Stripe has reclaimed the cash, so we MUST debit the ledger or we
 *       lose money.
 *
 *       Resolution path mirrors handleChargeRefunded:
 *         1. Retrieve the charge by `dispute.charge`.
 *         2. Read organizationId / stripeSessionId / packId from charge.metadata.
 *         3. If stripeSessionId is unresolved (absent or SENTINEL_PENDING), backfill via the
 *            PaymentIntent (charge.metadata is a one-time snapshot taken at charge creation).
 *         4. Debit the ledger via BillingExtraService.refundPartial with a stable refId
 *            'dispute_<dispute.id>' — refundPartial's own idempotency on the refId guarantees
 *            this is a no-op on Stripe redelivery, even outside the per-family event guard
 *            (disputes do not fit the subscription/invoice ordering families, so we rely on
 *            the ledger-layer idempotency exclusively).
 *
 *       When organizationId / charge / pack cannot be resolved, emits
 *       'billing.refund.unresolved' for ops + logs a critical alert (mirrors handleChargeRefunded).
 * @param {Object} dispute - Stripe dispute object (data.object of charge.dispute.funds_withdrawn).
 * @param {Object} event - Full Stripe event (for traceability).
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleChargeDisputeFundsWithdrawn = async (dispute, event) => {
  const chargeId = dispute?.charge;
  const disputeId = dispute?.id;
  const amount = dispute?.amount ?? 0;

  if (!chargeId || !disputeId || amount <= 0) {
    logger.error('[billing.webhook] dispute.funds_withdrawn missing required fields', {
      disputeId,
      chargeId,
      amount,
      eventId: event?.id,
    });
    try {
      billingEvents.emit('billing.refund.unresolved', { reason: 'dispute_missing_fields', disputeId, chargeId, amount });
    } catch (evtErr) {
      logger.error('[billing.webhook] billing.refund.unresolved listener error (non-fatal)', {
        error: evtErr?.message ?? String(evtErr),
        stack: evtErr?.stack,
      });
    }
    return;
  }

  const stripe = getStripe();
  if (!stripe) {
    logger.error('[billing.webhook] dispute.funds_withdrawn — Stripe client unavailable, cannot resolve charge', {
      disputeId,
      chargeId,
    });
    return;
  }

  let organizationId = null;
  let stripeSessionId = null;
  let packId = null;
  let paymentIntentId = null;

  try {
    const charge = await stripe.charges.retrieve(chargeId);
    const meta = charge?.metadata ?? {};
    organizationId = meta.organizationId ?? null;
    stripeSessionId = meta.stripeSessionId ?? null;
    packId = meta.packId ?? null;
    paymentIntentId = charge?.payment_intent ?? null;
  } catch (err) {
    logger.error('[billing.webhook] dispute.funds_withdrawn charge fetch failed', {
      chargeId,
      disputeId,
      error: err?.message ?? String(err),
      stack: err?.stack,
    });
    // Surface to ops; do NOT throw — withIdempotency would dead-letter after 5 retries on a
    // permanently-broken Stripe lookup, but Stripe transient failures should still go through
    // the retry machinery, so we re-throw to let it count.
    throw err;
  }

  // Backfill via PaymentIntent when charge metadata is missing or carries the sentinel.
  if ((isUnresolved(stripeSessionId) || !organizationId || !packId) && paymentIntentId) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      const piMeta = paymentIntent?.metadata ?? {};
      if (isUnresolved(stripeSessionId)) stripeSessionId = piMeta.stripeSessionId ?? stripeSessionId;
      if (!packId) packId = piMeta.packId ?? null;
      if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) {
        const piOrgId = piMeta.organizationId;
        if (piOrgId && mongoose.Types.ObjectId.isValid(piOrgId)) {
          organizationId = piOrgId;
        }
      }
    } catch (err) {
      logger.error('[billing.webhook] dispute.funds_withdrawn PI fetch failed', {
        paymentIntentId,
        disputeId,
        chargeId,
        error: err?.message ?? String(err),
        stack: err?.stack,
      });
      // PI fetch failure is non-fatal — we may still have what we need from charge.metadata.
    }
  }

  // Could not resolve org / session — this charge is unrelated to billing extras (or metadata
  // was never propagated). Emit alert for manual reconciliation, do NOT crash.
  if (
    !organizationId ||
    !mongoose.Types.ObjectId.isValid(organizationId) ||
    isUnresolved(stripeSessionId)
  ) {
    logger.error('[billing] dispute.funds_withdrawn unresolved — manual reconciliation required', {
      disputeId,
      chargeId,
      paymentIntentId,
      organizationId,
      stripeSessionId,
      amount,
    });
    try {
      billingEvents.emit('billing.refund.unresolved', {
        reason: 'dispute_unresolved',
        disputeId,
        chargeId,
        paymentIntentId,
        amount,
      });
    } catch (evtErr) {
      logger.error('[billing.webhook] billing.refund.unresolved listener error (non-fatal)', {
        error: evtErr?.message ?? String(evtErr),
        stack: evtErr?.stack,
      });
    }
    return;
  }

  // Stable refId per dispute — refundPartial's ledger idempotency makes redelivery a no-op.
  // Disputes are independent of subscription/invoice cycles, so we deliberately skip the
  // per-family event-newer guard and rely on ledger-layer refId idempotency exclusively.
  const refId = `dispute_${disputeId}`;
  await BillingExtraService.refundPartial(organizationId, stripeSessionId, amount, packId, refId);

  // Critical alert — money has actually left the account.
  logger.error('[billing] dispute lost — funds withdrawn, ledger debited', {
    disputeId,
    chargeId,
    organizationId,
    stripeSessionId,
    amount,
    eventId: event?.id,
  });

  try {
    billingEvents.emit('billing.dispute.lost', {
      disputeId,
      chargeId,
      organizationId,
      stripeSessionId,
      amount,
    });
  } catch (evtErr) {
    logger.error('[billing.webhook] billing.dispute.lost listener error (non-fatal)', {
      error: evtErr?.message ?? String(evtErr),
      stack: evtErr?.stack,
    });
  }
};

/**
 * @description Handle customer.subscription.created event — defensive upsert.
 *              In practice arrives just after checkout.session.completed which already
 *              creates the Subscription doc. This handler is a safety net + handles
 *              edge cases (subscription created via Stripe Dashboard/API outside checkout flow
 *              (e.g. Payment Links, Stripe Dashboard manual subscriptions)).
 *
 *              When a DB doc already exists (normal checkout flow): uses updateIfEventNewer guard.
 *              When no DB doc exists (Dashboard/Payment Link creation): resolves the organization
 *              via stripeCustomerId and creates the subscription row so these edge-case
 *              subscriptions are not silently dropped.
 *
 *              Idempotent via updateIfEventNewer (existing) or event marker seeding (new row).
 * @param {Object} subscription - Stripe subscription object
 * @param {Object} event - Full Stripe event for event-ordering guard
 * @returns {Promise<void|{skipped: boolean, reason: string}>} Returns a skip sentinel
 *          `{ skipped: true, reason: 'duplicate' }` when a concurrent delivery triggers an
 *          E11000 duplicate-key error on create — graceful no-op, does not dead-letter.
 *          Returns void in all other cases (including stale-event skip via updateIfEventNewer).
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleSubscriptionCreated = async (subscription, event) => {
  const rawPeriodStart = subscription.items?.data?.[0]?.current_period_start ?? subscription.current_period_start;
  const newPeriodStart = rawPeriodStart ? new Date(rawPeriodStart * 1000) : undefined;

  const existing = await SubscriptionRepository.findByStripeSubscriptionId(subscription.id);
  if (!existing) {
    // No doc found via stripeSubscriptionId — could be a race with checkout.session.completed
    // or a subscription created outside the checkout flow (Stripe Dashboard / Payment Links).
    // Try to resolve the organization via stripeCustomerId and create the row.
    const orgSub = subscription.customer
      ? await SubscriptionRepository.findByStripeCustomerId(subscription.customer)
      : null;

    if (!orgSub) {
      // Cannot resolve org — truly external subscription with no prior customer mapping.
      // Log and skip; a later subscription.updated will reconcile when org is known.
      logger.info('[billing.webhook] subscription.created — cannot resolve org, will reconcile via next event', {
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer,
        eventId: event?.id,
      });
      return;
    }

    const organizationId = String(orgSub.organization?._id || orgSub.organization);
    // orgSub was found via stripeCustomerId, so the org already carries a plan (e.g. a Dashboard
    // second-subscription edge case) — retain it on an unresolvable price rather than defaulting
    // to 'free', since syncOrganizationPlan below writes the shared org-level plan field (#3970).
    const newPlan = resolvePlan(subscription, orgSub.plan, { organizationId, eventId: event?.id });
    logger.info('[billing.webhook] subscription.created — creating DB row for Dashboard/Payment Link subscription', {
      stripeSubscriptionId: subscription.id,
      organizationId,
      eventId: event?.id,
    });
    try {
      await SubscriptionRepository.create({
        organization: organizationId,
        stripeCustomerId: subscription.customer,
        stripeSubscriptionId: subscription.id,
        plan: newPlan,
        status: subscription.status,
        lastSubscriptionEventCreatedAt: event.created,
        lastSubscriptionEventId: event.id,
        ...(newPeriodStart ? { currentPeriodStart: newPeriodStart } : {}),
      });
    } catch (err) {
      if (err.code === 11000) {
        // Duplicate key — a concurrent subscription.created delivery (or checkout.session.completed
        // racing ahead) already inserted the row. Skip creation gracefully; the existing row
        // carries the correct state and withIdempotency will not dead-letter this event.
        logger.warn('[billing.webhook] secondary subscription detected for org, skipping duplicate creation', {
          organizationId,
          stripeSubscriptionId: subscription.id,
          eventId: event?.id,
        });
        return { skipped: true, reason: 'duplicate' };
      }
      throw err;
    }
    await syncOrganizationPlan(organizationId, newPlan);

    // Keeps the stored week snapshot honest for reconcile/display-fallback — same
    // rationale as the checkout.session.completed activation path above.
    try {
      await BillingResetService.forceRotateForPlanChange(organizationId, { preserveUsage: true });
    } catch (err) {
      logger.warn('[billing.webhook] forceRotateForPlanChange failed after subscription.created (new row)', {
        organizationId,
        error: err?.message ?? String(err),
      });
    }
    return;
  }

  const organizationId = String(existing.organization?._id || existing.organization);
  const newPlan = resolvePlan(subscription, existing.plan, { organizationId, eventId: event?.id });

  const fields = {
    plan: newPlan,
    status: subscription.status,
  };
  if (newPeriodStart) fields.currentPeriodStart = newPeriodStart;

  const updated = await SubscriptionRepository.updateIfEventNewer(
    String(existing._id),
    event.created,
    event.id,
    fields,
    'subscription',
  );
  if (!updated) {
    logger.info('[billing.webhook] skipped stale subscription.created event', { eventId: event.id });
    return;
  }

  await syncOrganizationPlan(organizationId, newPlan);

  // Keeps the stored week snapshot honest for reconcile/display-fallback — same
  // rationale as the checkout.session.completed activation path above.
  try {
    await BillingResetService.forceRotateForPlanChange(organizationId, { preserveUsage: true });
  } catch (err) {
    logger.warn('[billing.webhook] forceRotateForPlanChange failed after subscription.created (existing row)', {
      organizationId,
      error: err?.message ?? String(err),
    });
  }
};

/**
 * @description Handle charge.dispute.funds_reinstated event — fires when a previously-lost
 *              dispute is later resolved in the merchant's favor (appeal won, evidence accepted).
 *              The funds were debited via handleChargeDisputeFundsWithdrawn earlier; this handler
 *              MUST credit them back to keep the extras ledger accurate.
 *
 *              Implementation note: auto-compensation requires a `creditCompensation` repo
 *              method that adds an idempotent ledger entry (refId `dispute_reinstate_${disputeId}`).
 *              That method does not exist yet (Phase 1 admin toolkit will add it). Until then,
 *              this handler logs + emits a critical alert for manual ops resolution via the
 *              admin endpoint. The runbook documents the manual flow.
 *
 * @param {Object} dispute - Stripe dispute object
 * @param {Object} event - Full Stripe event
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const handleChargeDisputeFundsReinstated = async (dispute, event) => {
  const chargeId = dispute?.charge;
  const disputeId = dispute?.id;
  const amount = dispute?.amount ?? 0;

  // Validate required fields before logging/emitting — missing identifiers make ops investigation harder.
  if (!disputeId || !chargeId) {
    logger.error('[billing.webhook] dispute.funds_reinstated missing required fields — skipping emit', {
      disputeId,
      chargeId,
      amount,
      eventId: event?.id,
    });
    return;
  }

  // funds_reinstated requires immediate manual action (apply ledger credit via admin endpoint)
  // — log as error so this surfaces in error-level alerting dashboards, not buried in warn noise.
  logger.error('[billing.webhook] dispute.funds_reinstated received — ACTION REQUIRED: use POST /api/admin/billing/dispute/credit/:orgId to restore the extras balance', {
    disputeId,
    chargeId,
    amount,
    eventId: event?.id,
  });

  try {
    billingEvents.emit('billing.dispute.reinstated', {
      disputeId,
      chargeId,
      amount,
      eventId: event?.id,
    });
  } catch (evtErr) {
    logger.error('[billing.webhook] billing.dispute.reinstated listener error (non-fatal)', {
      error: evtErr?.message ?? String(evtErr),
      stack: evtErr?.stack,
    });
  }
};

export default {
  withIdempotency,
  handleCheckoutSessionCompleted,
  handleCheckoutCompleted,
  handleCheckoutPaymentCompleted,
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentFailed,
  handleInvoicePaymentSucceeded,
  handleChargeRefunded,
  handleCustomerDeleted,
  handleChargeDisputeCreated,
  handleChargeDisputeFundsWithdrawn,
  handleChargeDisputeFundsReinstated,
};
