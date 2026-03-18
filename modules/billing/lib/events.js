/**
 * Module dependencies
 */
import { EventEmitter } from 'events';

/**
 * Singleton event emitter for billing events.
 *
 * Events:
 *   - `plan.changed` — emitted when a subscription's plan changes
 *     Payload: { organizationId, previousPlan, newPlan, subscription, isDowngrade }
 */
const billingEvents = new EventEmitter();

export default billingEvents;
