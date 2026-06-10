/**
 * Module dependencies
 */
import { EventEmitter } from 'events';

/**
 * Singleton emitter for invitation events. Config-free / import-safe.
 *
 * Events:
 *   - `invitation.accepted` — emitted (P8a) by InvitationsService.accept when an invite
 *     is consumed by a successful signup (BOTH the local two-phase token path AND the
 *     OAuth-by-email path go through the same accept seam). Fire-and-forget: a listener
 *     throw is caught at the emit site, never breaks signup. Always emitted on accept.
 *     Payload: {
 *       invitationId:   String   — the accepted invite's id
 *       email:          String   — the invite's pinned (lowercased) email
 *       invitedBy:      ObjectId|null — the inviter user id, or null for an admin-created
 *                                       invite with no inviter
 *       acceptedUserId: String   — the just-created user's id (= the new user's referredBy
 *                                   source when invitedBy is set)
 *     }
 *
 * This file ships the singleton + the error-listener hook (registered in
 * invitations.init.js after config is ready) so it stays config-free and
 * importable without ordering hazards (mirrors billing/lib/events.js).
 */
const invitationEvents = new EventEmitter();

export default invitationEvents;
