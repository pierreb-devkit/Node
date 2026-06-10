/**
 * Invitations module constants. Config-free / import-safe.
 */

/**
 * Fallback validity (in days) for a signup invite link when
 * `config.sign.inviteExpiresInDays` is not set.
 */
export const DEFAULT_INVITE_EXPIRES_IN_DAYS = 14;

/**
 * E2 two-phase claim staleness window (minutes). A signup that CLAIMS an invite
 * (stamps `consumingAt`) but crashes before finalize/release leaves the invite
 * in-flight; after this many minutes with no `acceptedAt` it is swept (released)
 * and becomes reusable. Generous vs. the synchronous signup path (sub-second) so
 * a legitimately in-flight signup is never swept out from under itself.
 */
export const STALE_CLAIM_MINUTES = 15;

/**
 * Canonical admin/public mount for the invitations module.
 */
export const INVITATIONS_PATH_PREFIX = '/api/invitations';

/**
 * Back-compat alias prefix kept in auth.routes.js (before the greedy
 * `/api/auth/:strategy` wildcard) until the Vue admin store migrates off it.
 */
export const INVITATIONS_LEGACY_PATH_PREFIX = '/api/auth/invitations';
