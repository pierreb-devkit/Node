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
 *   - `billing.extras_debit.exhausted` — emitted when outbox extras debit retries fail 5 times
 *     Payload: { organizationId, idempotencyKey, extrasUnits, attempts, lastError }
 *   - `payment.failed`  — emitted when an invoice payment fails (pastDueSince set on first failure)
 *     Payload: { organizationId }
 */
const billingEvents = new EventEmitter();

export default billingEvents;
