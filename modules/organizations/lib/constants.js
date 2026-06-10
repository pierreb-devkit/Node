export const MEMBERSHIP_STATUSES = {
  ACTIVE: 'active',
  PENDING: 'pending',
};

export const MEMBERSHIP_ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
};

/**
 * Source discriminator for PENDING memberships — the consent split.
 *
 * A PENDING membership can exist for two distinct reasons, and the two MUST stay
 * separable so the owner-approval surface never sees (and so never auto-approves)
 * a membership the invited user has not consented to:
 *   - JOIN_REQUEST: the user asked to join (owner approves → ACTIVE). The owner is
 *     the one who consents; this is the legacy/default join flow.
 *   - OWNER_ADD: an owner/admin added a user (the INVITED USER accepts → ACTIVE).
 *     The owner must NEVER be able to approve this — only the invited user can,
 *     via acceptMembership. An owner_add appearing in the approval list would be a
 *     consent bypass.
 *
 * Stored on `membership.source`. There is intentionally NO schema default — a
 * forgotten `source` on a PENDING row must fail loudly (pre('validate') guard)
 * rather than silently default to a join_request the owner could approve.
 */
export const PENDING_SOURCES = {
  JOIN_REQUEST: 'join_request',
  OWNER_ADD: 'owner_add',
};
