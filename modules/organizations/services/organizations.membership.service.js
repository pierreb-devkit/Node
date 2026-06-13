/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';
import getBaseUrl from '../../../lib/helpers/getBaseUrl.js';
import mailer from '../../../lib/helpers/mailer/index.js';
import { assertEmailVerified } from '../../../lib/helpers/emailVerification.js';
import MembershipRepository from '../repositories/organizations.membership.repository.js';
import OrganizationRepository from '../repositories/organizations.repository.js';
import UserService from '../../users/services/users.service.js';
import { MEMBERSHIP_STATUSES, MEMBERSHIP_ROLES, PENDING_SOURCES } from '../lib/constants.js';

/**
 * E17 — migration-ordering defensive read.
 *
 * Pre-existing PENDING rows (created before the `source` field existed) carry no
 * `source` and were ALL join-requests. Until the backfill migration
 * (`20260610140000-backfill-membership-source`) is confirmed run in every
 * environment, the owner-approval surface must keep matching those legacy rows.
 * So "this is a join-request the owner may approve" === source is join_request
 * OR source is absent.
 *
 * REMOVE the `{ source: { $exists: false } }` branch once the backfill is
 * confirmed run everywhere (follow-up — see MIGRATIONS.md). After that, every
 * PENDING row has an explicit source (enforced by the model pre-validate guard).
 *
 * DOC-LEVEL TWIN: `isOwnerApprovable(source)` (organizations/lib/constants.js) is
 * the document-level expression of the SAME consent invariant — a PENDING row is
 * owner-approvable iff it is NOT an owner_add (join_request + legacy no-source).
 * A Mongo filter can't reuse a predicate, so this `$or` stays; keep the two in
 * lock-step (this filter selects the rows `isOwnerApprovable` returns true for).
 */
const joinRequestSourceFilter = {
  $or: [{ source: PENDING_SOURCES.JOIN_REQUEST }, { source: { $exists: false } }],
};

/**
 * @function validateLastOwnerProtection
 * @description Throws if there is only one active owner left in the organization.
 * @param {String} organizationId - The ID of the organization to check.
 * @returns {Promise<void>}
 * @throws {Error} If the organization has only one active owner.
 */
const validateLastOwnerProtection = async (organizationId) => {
  const ownerCount = await MembershipRepository.count({
    organizationId,
    role: MEMBERSHIP_ROLES.OWNER,
    status: MEMBERSHIP_STATUSES.ACTIVE,
  });
  if (ownerCount <= 1) {
    throw new Error('Organization must have at least one active owner');
  }
};

/**
 * @function list
 * @description Service to retrieve an organization's members surface: ACTIVE
 *   memberships PLUS pending owner_add invitations — so the inviting owner/admin
 *   can SEE (and cancel via DELETE /members/:memberId) an invite they created.
 *   Pending join_requests stay OUT: they have their own approval surface
 *   (listPending) and must never look like members. Rows carry status + source
 *   so callers can render the pending state.
 * @param {String} organizationId - The ID of the organization.
 * @param {String} [search] - Optional search string to filter by user name/email.
 * @param {Number} [page] - Optional page number for pagination.
 * @param {Number} [perPage] - Optional items per page for pagination.
 * @returns {Promise<Array>} A promise that resolves to the list of memberships.
 */
const list = async (organizationId, search, page, perPage) => {
  const filter = {
    organizationId,
    $or: [
      { status: MEMBERSHIP_STATUSES.ACTIVE },
      { status: MEMBERSHIP_STATUSES.PENDING, source: PENDING_SOURCES.OWNER_ADD },
    ],
  };
  if (search) {
    const matchingUsers = await UserService.searchByNameOrEmail(search);
    filter.userId = { $in: matchingUsers.map((u) => u._id) };
  }
  return MembershipRepository.list(filter, page, perPage);
};

/**
 * @function listByUser
 * @description Service to retrieve all active memberships for a given user.
 * @param {String} userId - The ID of the user.
 * @returns {Promise<Array>} A promise that resolves to the list of memberships.
 */
const listByUser = (userId) => MembershipRepository.list({ userId, status: MEMBERSHIP_STATUSES.ACTIVE });

/**
 * @function get
 * @description Service to fetch a single membership by its ID.
 * @param {String} id - The ID of the membership to fetch.
 * @returns {Promise<Object|null>} A promise resolving to the retrieved membership.
 */
const get = (id) => MembershipRepository.get(id);

/**
 * @function findByUserAndOrganization
 * @description Service to find an active membership by user and organization.
 * @param {String} userId - The ID of the user.
 * @param {String} organizationId - The ID of the organization.
 * @returns {Promise<Object|null>} A promise resolving to the membership or null.
 */
const findByUserAndOrganization = (userId, organizationId) =>
  MembershipRepository.findOne({ userId, organizationId, status: MEMBERSHIP_STATUSES.ACTIVE });

/**
 * @function create
 * @description Service to create a membership directly (active by default).
 * @param {Object} data - Membership data containing userId, organizationId, role, and optionally status.
 * @returns {Promise<Object>} A promise resolving to the created membership.
 */
const create = (data) => MembershipRepository.create(data);

/**
 * @function updateRole
 * @description Service to update the role of an existing membership.
 * @param {Object} membership - The existing membership object.
 * @param {String} role - The new role to assign.
 * @returns {Promise<Object>} A promise resolving to the updated membership.
 */
const updateRole = async (membership, role) => {
  if (membership.role === MEMBERSHIP_ROLES.OWNER && role !== MEMBERSHIP_ROLES.OWNER) {
    const orgId = membership.organizationId._id || membership.organizationId;
    await validateLastOwnerProtection(orgId);
  }
  membership.role = role;
  return MembershipRepository.update(membership);
};

/**
 * @function remove
 * @description Service to delete a membership.
 * @param {Object} membership - The membership to delete.
 * @returns {Promise<Object>} A promise resolving to a confirmation of the deletion.
 */
const remove = async (membership) => {
  // Last-owner protection applies ONLY to ACTIVE owner rows: cancelling a PENDING
  // owner-role invite never reduces the active-owner count, so it must not be
  // blocked when the org has a single active owner (the inviter) — #3831.
  if (membership.role === MEMBERSHIP_ROLES.OWNER && membership.status === MEMBERSHIP_STATUSES.ACTIVE) {
    const orgId = membership.organizationId._id || membership.organizationId;
    await validateLastOwnerProtection(orgId);
  }
  const userId = membership.userId._id || membership.userId;
  const removedOrgId = membership.organizationId._id || membership.organizationId;
  await MembershipRepository.remove(membership);

  // Clear currentOrganization if it pointed to the org the user was removed from
  const userDoc = await UserService.getBrut({ id: String(userId) });
  if (userDoc && String(userDoc.currentOrganization) === String(removedOrgId)) {
    const remaining = await MembershipRepository.list({ userId, status: MEMBERSHIP_STATUSES.ACTIVE });
    const nextOrg = remaining.length > 0 ? (remaining[0].organizationId._id || remaining[0].organizationId) : null;
    await UserService.updateById(userDoc._id, { currentOrganization: nextOrg });
  }
  return { success: true };
};

/**
 * @function listPending
 * @description Service to retrieve pending JOIN REQUESTS for an organization (the
 *   owner/admin approval surface). Scoped to `source: 'join_request'` so an
 *   owner_add (which awaits the INVITED user's consent, not the owner's approval)
 *   NEVER appears here — invariant #1. E17 fallback keeps pre-backfill legacy rows
 *   (no `source`) visible.
 * @param {String} organizationId - The ID of the organization.
 * @returns {Promise<Array>} A promise that resolves to the list of pending join requests.
 */
const listPending = (organizationId) =>
  MembershipRepository.list({ organizationId, status: MEMBERSHIP_STATUSES.PENDING, ...joinRequestSourceFilter });

/**
 * @function listPendingByUser
 * @description Service to retrieve a user's own pending JOIN REQUESTS (the requests
 *   they initiated and are awaiting approval on). Scoped to `source: 'join_request'`
 *   (+ E17 legacy fallback) — owner_add invitations the user must ACCEPT are a
 *   distinct surface (see listPendingOwnerAddsByUser / the my-pending endpoint).
 *   Feeds the auth-payload `pendingRequests` ("your request to join X is pending").
 * @param {String} userId - The ID of the user.
 * @returns {Promise<Array>} A promise that resolves to the list of pending join requests.
 */
const listPendingByUser = (userId) =>
  MembershipRepository.list({ userId, status: MEMBERSHIP_STATUSES.PENDING, ...joinRequestSourceFilter });

/**
 * @function listPendingOwnerAddsByUser
 * @description Service to retrieve a user's pending OWNER_ADD invitations — the
 *   memberships an owner/admin created for them that they must ACCEPT to activate.
 *   Powers the "pending invitations to accept" list (my-pending endpoint, P5b).
 *   Scoped to `source: 'owner_add'` exactly (no legacy fallback — pre-backfill rows
 *   were all join_requests, never owner_adds).
 * @param {String} userId - The ID of the user.
 * @returns {Promise<Array>} A promise resolving to the user's pending owner_add memberships.
 */
const listPendingOwnerAddsByUser = (userId) =>
  MembershipRepository.list({ userId, status: MEMBERSHIP_STATUSES.PENDING, source: PENDING_SOURCES.OWNER_ADD });

/**
 * @function createJoinRequest
 * @description Create a pending membership (join request). When mailer is configured, requires email
 *   verification first (throws AppError with code FORBIDDEN / status 403 if not verified).
 *   Also validates no existing active/pending membership and enforces a single pending request limit.
 * @param {String} userId - The ID of the requesting user.
 * @param {String} organizationId - The ID of the organization to join.
 * @returns {Promise<Object>} The created pending membership.
 * @throws {AppError} If mailer is configured and user email is not verified.
 */
const createJoinRequest = async (userId, organizationId) => {
  const user = await UserService.getBrut({ id: String(userId) });
  if (!user) throw new Error('User not found');
  assertEmailVerified(user);

  // Per-(user,org) duplicate guard: ANY existing membership blocks a join request,
  // regardless of source — you cannot request to join an org you already have an
  // active membership in, a pending join_request for, or a pending owner_add invite to.
  const existing = await MembershipRepository.findOne({ userId, organizationId, status: { $in: [MEMBERSHIP_STATUSES.ACTIVE, MEMBERSHIP_STATUSES.PENDING] } });
  if (existing) {
    if (existing.status === MEMBERSHIP_STATUSES.ACTIVE) throw new Error('Already a member of this organization');
    if (existing.source === PENDING_SOURCES.OWNER_ADD) throw new Error('You already have a pending invitation to this organization. Please accept or decline it.');
    throw new Error('A pending request already exists');
  }
  // Limit to 1 pending JOIN REQUEST at a time across all organizations. Source-scoped
  // (+ E17 legacy fallback): a pending owner_add invitation in another org must NOT
  // block the user from requesting to join — the two surfaces are orthogonal.
  const pendingAnywhere = await MembershipRepository.findOne({ userId, status: MEMBERSHIP_STATUSES.PENDING, ...joinRequestSourceFilter });
  if (pendingAnywhere) throw new Error('You already have a pending request. Please wait for it to be reviewed before requesting to join another organization.');
  const membership = await MembershipRepository.create({ userId, organizationId, role: MEMBERSHIP_ROLES.MEMBER, status: MEMBERSHIP_STATUSES.PENDING, source: PENDING_SOURCES.JOIN_REQUEST });

  if (mailer.isConfigured()) {
    const org = await OrganizationRepository.get(organizationId);
    if (user?.email && org?.name) {
      const admins = await MembershipRepository.list({ organizationId, role: { $in: [MEMBERSHIP_ROLES.OWNER, MEMBERSHIP_ROLES.ADMIN] }, status: MEMBERSHIP_STATUSES.ACTIVE });
      for (const admin of admins) {
        if (admin.userId?.email) {
          mailer.sendMail({
            to: admin.userId.email,
            subject: `New join request for ${org.name}`,
            template: 'org-request-new',
            params: {
              requesterName: [user.firstName, user.lastName].filter(Boolean).join(' '),
              requesterEmail: user.email,
              orgName: org.name,
              url: `${getBaseUrl()}/users/organizations/${organizationId}`,
              appName: config.app.title,
            },
          }).catch((err) => logger.warn('organizations.membership.createJoinRequest: admin notification email failed', { message: err?.message, stack: err?.stack }));
        }
      }
    }
  }

  return membership;
};

/**
 * @function approveRequest
 * @description Approve a pending membership request — sets status to active and optionally sets user's currentOrganization.
 * @param {Object} membership - The pending membership to approve.
 * @returns {Promise<Object>} The updated membership.
 */
const approveRequest = async (membership) => {
  membership.status = MEMBERSHIP_STATUSES.ACTIVE;
  const result = await MembershipRepository.update(membership);

  // Set currentOrganization if user doesn't have one
  const userId = membership.userId._id || membership.userId;
  const userDoc = await UserService.getBrut({ id: String(userId) });
  if (userDoc && !userDoc.currentOrganization) {
    await UserService.updateById(userDoc._id, {
      currentOrganization: membership.organizationId._id || membership.organizationId,
    });
  }

  if (mailer.isConfigured()) {
    const approvedUserId = membership.userId._id || membership.userId;
    const user = await UserService.getBrut({ id: String(approvedUserId) });
    const org = await OrganizationRepository.get(membership.organizationId._id || membership.organizationId);
    if (user?.email && org?.name) {
      mailer.sendMail({
        to: user.email,
        subject: `Your request to join ${org.name} has been approved`,
        template: 'org-request-approved',
        params: {
          displayName: [user.firstName, user.lastName].filter(Boolean).join(' '),
          orgName: org.name,
          appName: config.app.title,
        },
      }).catch((err) => logger.warn('organizations.membership.approveRequest: approval email failed', { message: err?.message, stack: err?.stack }));
    }
  }

  return result;
};

/**
 * @function rejectRequest
 * @description Reject a pending membership request by removing the record, allowing the user to re-apply.
 * @param {Object} membership - The pending membership to reject.
 * @returns {Promise<Object>} A confirmation of the deletion.
 */
const rejectRequest = async (membership) => {
  if (mailer.isConfigured()) {
    const userId = membership.userId._id || membership.userId;
    const user = await UserService.getBrut({ id: String(userId) });
    const orgId = membership.organizationId._id || membership.organizationId;
    const org = await OrganizationRepository.get(orgId);
    if (user?.email && org?.name) {
      mailer.sendMail({
        to: user.email,
        subject: `Your request to join ${org.name}`,
        template: 'org-request-rejected',
        params: {
          displayName: [user.firstName, user.lastName].filter(Boolean).join(' '),
          orgName: org.name,
          appName: config.app.title,
        },
      }).catch((err) => logger.warn('organizations.membership.rejectRequest: rejection email failed', { message: err?.message, stack: err?.stack }));
    }
  }
  return MembershipRepository.remove(membership);
};

/**
 * @function findUserByExactEmail
 * @description Look up a single user by EXACT email for the owner/admin add-member
 *   affordance (P5b). "Exact" means exact-after-normalization: the lookup matches
 *   modulo `normalizeEmail` (lowercased + trimmed), which is correct — that is the
 *   form emails are stored under (the CI-unique-email index), so this is an exact
 *   match on the canonical value, NOT a byte-for-byte raw-string match.
 *   GDPR/privacy: exact-match only (no fuzzy name enumeration of the user
 *   directory). Returns minimal identity (id, displayName, email) for a match, or
 *   null. Authorization (owner/admin-only) is enforced at the controller.
 * @param {String} email - The email to look up (matched lowercased/trimmed).
 * @returns {Promise<{id: String, displayName: String, email: String}|null>} The matched user or null.
 */
const findUserByExactEmail = async (email) => {
  const user = await UserService.findByEmail(email);
  if (!user) return null;
  return {
    id: String(user._id || user.id),
    displayName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    email: user.email,
  };
};

/**
 * @function addMember
 * @description Owner/admin adds a user to the organization. Creates a PENDING
 *   membership tagged `source: 'owner_add'`. CONSENT-CRITICAL: the membership does
 *   NOT activate here and NEVER appears in the owner's join-request approval list
 *   (invariant #1) — only the INVITED USER can activate it via acceptMembership.
 *
 *   `status` is set EXPLICITLY to PENDING: the model defaults `status` to 'active',
 *   so omitting it would silently create an ACTIVE member without consent — a worse
 *   bypass than the approval-surface leak. The model pre-validate guard also rejects
 *   a PENDING row with no source.
 *
 *   Rejects if ANY membership already exists for (user, org) — active, pending
 *   join_request, or pending owner_add — so an owner cannot double-add, stack an
 *   invite onto a member, or race a user's join request.
 * @param {String} organizationId - The organization to add the user to.
 * @param {String} userId - The user being invited.
 * @param {String} [role] - The role to grant on acceptance (defaults to MEMBER).
 * @param {String} addedBy - The id of the owner/admin performing the add (provenance).
 * @returns {Promise<Object>} The created PENDING owner_add membership. When the
 *   mailer is configured, also notifies the invited user by email (invitation
 *   wording — the membership awaits THEIR acceptance) with a link to their
 *   organizations page. Fire-and-forget: a mail failure never fails the add.
 * @throws {Error} If userId is missing, the user does not exist, or a membership already exists.
 */
const addMember = async (organizationId, userId, role, addedBy) => {
  if (!userId) throw new Error('A user is required to add a member');
  const user = await UserService.getBrut({ id: String(userId) });
  if (!user) throw new Error('User not found');

  // Per-(user,org) guard across BOTH sources and both statuses — an owner_add must
  // not duplicate, nor be stacked on an existing membership / pending join request.
  const existing = await MembershipRepository.findOne({
    userId,
    organizationId,
    status: { $in: [MEMBERSHIP_STATUSES.ACTIVE, MEMBERSHIP_STATUSES.PENDING] },
  });
  if (existing) {
    if (existing.status === MEMBERSHIP_STATUSES.ACTIVE) throw new Error('User is already a member of this organization');
    throw new Error('This user already has a pending membership for this organization');
  }

  // status EXPLICIT — never rely on the schema 'active' default (consent bypass).
  const membership = await MembershipRepository.create({
    userId,
    organizationId,
    role: role || MEMBERSHIP_ROLES.MEMBER,
    status: MEMBERSHIP_STATUSES.PENDING,
    source: PENDING_SOURCES.OWNER_ADD,
    addedBy,
  });

  // Invitation notification (parity with the join-request emails). The membership
  // is PENDING — only the invitee can activate it via acceptMembership (consent
  // invariant #1) — so the wording is an invitation, never a "you were added"
  // fait accompli. Fire-and-forget: a mail failure must never fail the add.
  const org = await OrganizationRepository.get(organizationId);
  if (mailer.isConfigured() && user?.email && org?.name) {
    mailer.sendMail({
      to: user.email,
      subject: `You have been invited to join ${org.name}`,
      template: 'org-member-added',
      params: {
        displayName: [user.firstName, user.lastName].filter(Boolean).join(' '),
        orgName: org.name,
        appName: config.app.title,
        url: `${getBaseUrl()}/users/organizations`,
      },
    }).catch((err) => logger.warn('organizations.membership.addMember: invitation email failed', { message: err?.message, stack: err?.stack }));
  }

  return membership;
};

/**
 * @function acceptMembership
 * @description The INVITED USER accepts a pending owner_add membership, flipping it
 *   PENDING → ACTIVE. CONSENT-CRITICAL — this is the ONLY path that activates an
 *   owner_add, and it activates ONLY for the invited user:
 *     - the membership must be PENDING and `source === 'owner_add'` (a join_request
 *       is approved by the owner via approveRequest, NOT accepted here);
 *     - `membership.userId` must equal `acceptingUserId` — the owner (or anyone
 *       else) accepting on the invitee's behalf is rejected.
 *   Returns null on any consent-mismatch so the controller can answer 403/404
 *   without leaking which condition failed. On success, sets the user's
 *   currentOrganization if they have none (mirrors approveRequest).
 * @param {String} membershipId - The pending owner_add membership to accept.
 * @param {String} acceptingUserId - The authenticated user accepting (must be the invitee).
 * @returns {Promise<Object|null>} The activated membership, or null if not acceptable by this user.
 */
const acceptMembership = async (membershipId, acceptingUserId) => {
  // Self-defending consent gate: an absent caller can never own a membership, and
  // `String(undefined) === String(membership.userId?._id || undefined)` could
  // sentinel-collide. Reject up-front so the gate never leans on the route being
  // auth-only (null → 404, matching the not-found / not-eligible path).
  if (!acceptingUserId) return null;
  const membership = await MembershipRepository.get(membershipId);
  if (!membership) return null;

  // Consent gate. Compare the membership owner to the caller; an owner_add can ONLY
  // be accepted by its invited user. A join_request, an already-active membership,
  // or another user's invite are all rejected (null → 404/403 at the controller).
  const membershipUserId = String(membership.userId?._id || membership.userId);
  const isOwnerAddPending = membership.status === MEMBERSHIP_STATUSES.PENDING
    && membership.source === PENDING_SOURCES.OWNER_ADD;
  if (!isOwnerAddPending || membershipUserId !== String(acceptingUserId)) return null;

  membership.status = MEMBERSHIP_STATUSES.ACTIVE;
  const result = await MembershipRepository.update(membership);

  // Set currentOrganization if the accepting user doesn't have one (parity with approveRequest).
  const userDoc = await UserService.getBrut({ id: String(acceptingUserId) });
  if (userDoc && !userDoc.currentOrganization) {
    await UserService.updateById(userDoc._id, {
      currentOrganization: membership.organizationId._id || membership.organizationId,
    });
  }

  return result;
};

/**
 * @function declineMembership
 * @description The INVITED USER declines a pending owner_add membership, deleting
 *   the row. CONSENT-CRITICAL — the gate is IDENTICAL to acceptMembership: the
 *   membership must be PENDING + source 'owner_add' AND belong to the
 *   authenticated caller; any mismatch (wrong user, a join_request, an
 *   already-active or unknown membership) returns null so the controller can
 *   answer 404 without leaking which condition failed. Deleting (not flagging)
 *   mirrors rejectRequest — the user can be re-invited later. This makes the
 *   createJoinRequest copy ('Please accept or decline it') honest.
 * @param {String} membershipId - The pending owner_add membership to decline.
 * @param {String} decliningUserId - The authenticated user declining (must be the invitee).
 * @returns {Promise<Object|null>} The deleted membership row, or null if not declinable by this user.
 */
const declineMembership = async (membershipId, decliningUserId) => {
  // Self-defending consent gate, same rationale as acceptMembership: reject an
  // absent caller up-front so the String(undefined) compare can never collide.
  if (!decliningUserId) return null;
  const membership = await MembershipRepository.get(membershipId);
  if (!membership) return null;

  const membershipUserId = String(membership.userId?._id || membership.userId);
  const isOwnerAddPending = membership.status === MEMBERSHIP_STATUSES.PENDING
    && membership.source === PENDING_SOURCES.OWNER_ADD;
  if (!isOwnerAddPending || membershipUserId !== String(decliningUserId)) return null;

  await MembershipRepository.remove(membership);
  return membership;
};

/**
 * @function leave
 * @description Leave an organization. Prevents the last owner from leaving.
 * @param {String} userId - The ID of the user leaving.
 * @param {String} organizationId - The ID of the organization to leave.
 * @returns {Promise<Object>} A success confirmation.
 */
const leave = async (userId, organizationId) => {
  const membership = await MembershipRepository.findOne({ userId, organizationId, status: MEMBERSHIP_STATUSES.ACTIVE });
  if (!membership) throw new Error('You are not a member of this organization');
  if (membership.role === MEMBERSHIP_ROLES.OWNER) {
    await validateLastOwnerProtection(organizationId);
  }
  await MembershipRepository.remove(membership);

  const userDoc = await UserService.getBrut({ id: String(userId) });
  if (userDoc && String(userDoc.currentOrganization) === String(organizationId)) {
    const remaining = await MembershipRepository.list({ userId, status: MEMBERSHIP_STATUSES.ACTIVE });
    const nextOrg = remaining.length > 0 ? (remaining[0].organizationId._id || remaining[0].organizationId) : null;
    await UserService.updateById(userDoc._id, { currentOrganization: nextOrg });
  }
  return { success: true };
};

/**
 * @function count
 * @description Service to count memberships matching a filter.
 * @param {Object} filter - The filter criteria.
 * @returns {Promise<Number>} A promise resolving to the count.
 */
const count = (filter) => MembershipRepository.count(filter);

/**
 * @function aggregateCountByOrganizations
 * @description Service to count active members per organization using aggregation.
 * @param {Array} orgIds - Array of organization IDs.
 * @returns {Promise<Array>} Array of { _id: orgId, count: number } objects.
 */
const aggregateCountByOrganizations = (orgIds) => MembershipRepository.aggregateCountByOrganizations(orgIds);

/**
 * @function deleteMany
 * @description Service to delete multiple memberships based on a filter.
 * @param {Object} filter - The filter to apply to the deletion query.
 * @returns {Promise<Object>} A confirmation of the deletion.
 */
const deleteMany = (filter) => MembershipRepository.deleteMany(filter);

/**
 * @function listByUsers
 * @description Service to batch-fetch active memberships for multiple users in a single query.
 * @param {Array} userIds - Array of user IDs.
 * @returns {Promise<Array>} A promise that resolves to all matching memberships.
 */
const listByUsers = (userIds) => MembershipRepository.listByUsers(userIds);

export default {
  list,
  listByUser,
  listByUsers,
  get,
  findByUserAndOrganization,
  create,
  updateRole,
  remove,
  leave,
  listPending,
  listPendingByUser,
  listPendingOwnerAddsByUser,
  createJoinRequest,
  approveRequest,
  rejectRequest,
  findUserByExactEmail,
  addMember,
  acceptMembership,
  declineMembership,
  count,
  aggregateCountByOrganizations,
  deleteMany,
};
