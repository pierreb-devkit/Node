/**
 * Module dependencies
 */
import crypto from 'crypto';

import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';
import getBaseUrl from '../../../lib/helpers/getBaseUrl.js';
import mailer from '../../../lib/helpers/mailer/index.js';
import { assertEmailVerified } from '../../../lib/helpers/emailVerification.js';
import MembershipRepository from '../repositories/organizations.membership.repository.js';
import OrganizationRepository from '../repositories/organizations.repository.js';
import UserService from '../../users/services/users.service.js';

/**
 * @function list
 * @description Service to retrieve active memberships for an organization.
 * @param {String} organizationId - The ID of the organization.
 * @param {String} [search] - Optional search string to filter by user name/email.
 * @param {Number} [page] - Optional page number for pagination.
 * @param {Number} [perPage] - Optional items per page for pagination.
 * @returns {Promise<Array>} A promise that resolves to the list of memberships.
 */
const list = async (organizationId, search, page, perPage) => {
  const filter = { organizationId, status: 'active' };
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
const listByUser = (userId) => MembershipRepository.list({ userId, status: 'active' });

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
  MembershipRepository.findOne({ userId, organizationId, status: 'active' });

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
  if (membership.role === 'owner' && role !== 'owner') {
    const orgId = membership.organizationId._id || membership.organizationId;
    const ownerCount = await MembershipRepository.count({ organizationId: orgId, role: 'owner', status: 'active' });
    if (ownerCount <= 1) throw new Error('Cannot change role of the last owner');
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
  if (membership.role === 'owner') {
    const orgId = membership.organizationId._id || membership.organizationId;
    const ownerCount = await MembershipRepository.count({ organizationId: orgId, role: 'owner', status: 'active' });
    if (ownerCount <= 1) throw new Error('Cannot remove the last owner of an organization');
  }
  const userId = membership.userId._id || membership.userId;
  const removedOrgId = membership.organizationId._id || membership.organizationId;
  await MembershipRepository.remove(membership);

  // Clear currentOrganization if it pointed to the org the user was removed from
  const userDoc = await UserService.getBrut({ id: String(userId) });
  if (userDoc && String(userDoc.currentOrganization) === String(removedOrgId)) {
    const remaining = await MembershipRepository.list({ userId, status: 'active' });
    const nextOrg = remaining.length > 0 ? (remaining[0].organizationId._id || remaining[0].organizationId) : null;
    await UserService.updateById(userDoc._id, { currentOrganization: nextOrg });
  }
  return { success: true };
};

/**
 * @function listPending
 * @description Service to retrieve pending join requests for an organization.
 * @param {String} organizationId - The ID of the organization.
 * @returns {Promise<Array>} A promise that resolves to the list of pending memberships.
 */
const listPending = (organizationId) => MembershipRepository.list({ organizationId, status: 'pending' });

/**
 * @function listPendingByUser
 * @description Service to retrieve pending join requests for a user.
 * @param {String} userId - The ID of the user.
 * @returns {Promise<Array>} A promise that resolves to the list of pending memberships.
 */
const listPendingByUser = (userId) => MembershipRepository.list({ userId, status: 'pending' });

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

  const existing = await MembershipRepository.findOne({ userId, organizationId, status: { $in: ['active', 'pending'] } });
  if (existing) {
    if (existing.status === 'active') throw new Error('Already a member of this organization');
    throw new Error('A pending request already exists');
  }
  // Limit to 1 pending request at a time across all organizations
  const pendingAnywhere = await MembershipRepository.findOne({ userId, status: 'pending' });
  if (pendingAnywhere) throw new Error('You already have a pending request. Please wait for it to be reviewed before requesting to join another organization.');
  const membership = await MembershipRepository.create({ userId, organizationId, role: 'member', status: 'pending' });

  if (mailer.isConfigured()) {
    const org = await OrganizationRepository.get(organizationId);
    if (user?.email && org?.name) {
      const admins = await MembershipRepository.list({ organizationId, role: { $in: ['owner', 'admin'] }, status: 'active' });
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
  membership.status = 'active';
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
 * @function leave
 * @description Leave an organization. Prevents the last owner from leaving.
 * @param {String} userId - The ID of the user leaving.
 * @param {String} organizationId - The ID of the organization to leave.
 * @returns {Promise<Object>} A success confirmation.
 */
const leave = async (userId, organizationId) => {
  const membership = await MembershipRepository.findOne({ userId, organizationId, status: 'active' });
  if (!membership) throw new Error('You are not a member of this organization');
  if (membership.role === 'owner') {
    const ownerCount = await MembershipRepository.count({ organizationId, role: 'owner', status: 'active' });
    if (ownerCount <= 1) throw new Error('You are the last owner. Promote another member before leaving.');
  }
  await MembershipRepository.remove(membership);

  const userDoc = await UserService.getBrut({ id: String(userId) });
  if (userDoc && String(userDoc.currentOrganization) === String(organizationId)) {
    const remaining = await MembershipRepository.list({ userId, status: 'active' });
    const nextOrg = remaining.length > 0 ? (remaining[0].organizationId._id || remaining[0].organizationId) : null;
    await UserService.updateById(userDoc._id, { currentOrganization: nextOrg });
  }
  return { success: true };
};

/**
 * @function invite
 * @description Invite a user to an organization by email. Creates an invited membership with a token.
 * @param {String} organizationId - The ID of the organization.
 * @param {String} email - The email address to invite.
 * @param {Object} invitedBy - The user object of the inviter.
 * @returns {Promise<Object>} The created membership and invite token.
 */
const invite = async (organizationId, email, invitedBy) => {
  // Check for existing invited membership by email first (handles non-registered users)
  const existingInvite = await MembershipRepository.findOne({
    invitedEmail: email.toLowerCase(),
    organizationId,
    status: 'invited',
  });
  if (existingInvite) throw new Error('An invite has already been sent to this email');

  const existingUser = await UserService.findByEmail(email);
  if (existingUser) {
    const existingMembership = await MembershipRepository.findOne({
      userId: existingUser._id,
      organizationId,
      status: { $in: ['active', 'pending', 'invited'] },
    });
    if (existingMembership) throw new Error('User is already a member or has a pending request');
  }

  const inviteToken = crypto.randomBytes(20).toString('hex');
  const membership = await MembershipRepository.create({
    userId: existingUser ? existingUser._id : null,
    organizationId,
    role: 'member',
    status: 'invited',
    inviteToken,
    invitedEmail: email.toLowerCase(),
    inviteExpiresAt: new Date(Date.now() + 7 * 24 * 3600000),
  });

  if (mailer.isConfigured()) {
    const org = await OrganizationRepository.get(organizationId);
    if (org?.name) {
      try {
        await mailer.sendMail({
          to: email,
          subject: `You've been invited to join ${org.name}`,
          template: 'org-invite',
          params: {
            inviterName: [invitedBy.firstName, invitedBy.lastName].filter(Boolean).join(' '),
            orgName: org.name,
            url: `${getBaseUrl()}/invite?token=${inviteToken}`,
            appName: config.app.title,
            appContact: config.mailer.from,
          },
        });
      } catch {
        // Clean up persisted membership so the invite can be retried
        await MembershipRepository.remove(membership);
        throw new Error('Failed to send invite email');
      }
    }
  }

  return { membership, inviteToken };
};

/**
 * @function acceptInvite
 * @description Accept an organization invite by token. Sets the membership to active.
 * @param {String} token - The invite token.
 * @param {String} userId - The ID of the accepting user.
 * @returns {Promise<Object>} The updated membership.
 */
const acceptInvite = async (token, userId) => {
  const membership = await MembershipRepository.findOne({ inviteToken: token, status: 'invited' });
  if (!membership) throw new Error('Invalid or expired invite');

  if (membership.inviteExpiresAt && membership.inviteExpiresAt < Date.now()) {
    throw new Error('Invite has expired');
  }

  // Verify the accepting user matches the intended invite recipient
  const user = await UserService.getBrut({ id: String(userId) });
  if (!user) throw new Error('User not found');

  const invitedUserId = membership.userId?._id || membership.userId;
  if (invitedUserId && String(invitedUserId) !== String(userId)) {
    throw new Error('This invite belongs to another user');
  }
  if (membership.invitedEmail && membership.invitedEmail.toLowerCase() !== user.email.toLowerCase()) {
    throw new Error('This invite belongs to another email address');
  }

  membership.userId = userId;
  membership.status = 'active';
  membership.inviteToken = null;
  const result = await MembershipRepository.update(membership);

  if (user && !user.currentOrganization) {
    await UserService.updateById(user._id, {
      currentOrganization: membership.organizationId._id || membership.organizationId,
    });
  }

  return result;
};

/**
 * @function getInvite
 * @description Get invite details by token.
 * @param {String} token - The invite token.
 * @returns {Promise<Object|null>} The invited membership or null.
 */
const getInvite = (token) => MembershipRepository.findOne({ inviteToken: token, status: 'invited' });

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
  createJoinRequest,
  approveRequest,
  rejectRequest,
  invite,
  acceptInvite,
  getInvite,
  count,
  aggregateCountByOrganizations,
  deleteMany,
};
