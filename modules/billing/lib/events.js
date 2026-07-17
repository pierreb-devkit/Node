/**
 * Module dependencies
 */
import { EventEmitter } from 'events';

/**
 * Singleton event emitter for billing events.
 *
 * Events:
 *   - `plan.changed`    — emitted when a subscription's plan changes
 *     Payload: { organizationId, previousPlan, newPlan, subscription, isDowngrade }
 *   - `billing.plan_change.rotated` — emitted after current-week meter snapshot refresh
 *     Payload: { organizationId, oldQuota, newQuota, oldVersion, newVersion, preserveUsage }
 *   - `billing.extras_debit.exhausted` — emitted when outbox extras debit retries exhaust
 *     Payload: { organizationId, idempotencyKey, extrasUnits, attempts, lastError }
 *   - `payment.failed`  — emitted when an invoice payment fails (pastDueSince set on first failure)
 *     Payload: { organizationId }
 *   - `billing.refund.unresolved` — emitted when a charge.refunded event cannot be correlated
 *     to a known session/org (missing metadata on charge AND PaymentIntent, or ambiguous pack).
 *     Payload: { chargeId, paymentIntentId, refundAmount } | { reason, orgId, stripeSessionId, amountRefundedCents }
 *   - `billing.webhook.plan_unresolved` — emitted when a webhook's Stripe subscription price
 *     cannot be resolved to a plan (unmapped priceId AND no valid metadata.planId) — the write
 *     retains the last-known plan (or 'free' for a genuinely new org) instead of forcing 'free'.
 *     Payload: { organizationId, stripeSubscriptionId, priceId, retainedPlan, hadKnownPlan, eventId }
 *
 * NOTE: The 'error' event listener is registered in billing.init.js (after config is ready)
 * to avoid module-load-time config reads in this low-level singleton.
 */
const billingEvents = new EventEmitter();

export default billingEvents;
