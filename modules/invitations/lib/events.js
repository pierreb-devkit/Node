/**
 * Module dependencies
 */
import { EventEmitter } from 'events';

/**
 * Singleton emitter for invitation events. Config-free / import-safe.
 *
 * Events:
 *   - `invitation.accepted` — emitted when an invite is consumed by a signup
 *     Payload: { invitationId, email, invitedBy, acceptedUserId }
 *
 * NOTE: no event is emitted yet — P8 wires the actual `invitation.accepted` emit.
 * This file ships the singleton + the error-listener hook (registered in
 * invitations.init.js after config is ready) so it stays config-free and
 * importable without ordering hazards (mirrors billing/lib/events.js).
 */
const invitationEvents = new EventEmitter();

export default invitationEvents;
