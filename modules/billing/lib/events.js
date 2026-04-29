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
 *   - `payment.failed`  — emitted when an invoice payment fails (pastDueSince set on first failure)
 *     Payload: { organizationId }
 */
const billingEvents = new EventEmitter();

export default billingEvents;
