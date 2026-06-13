/**
 * Module dependencies
 */
import crypto from 'crypto';
import _ from 'lodash';

import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';
import getBaseUrl from '../../../lib/helpers/getBaseUrl.js';
import mailer from '../../../lib/helpers/mailer/index.js';
import AuthService from '../../auth/services/auth.service.js';
import UserRepository from '../repositories/users.repository.js';
import MembershipService from '../../organizations/services/organizations.membership.service.js';
import OrganizationsRepository from '../../organizations/repositories/organizations.repository.js';
import MembershipRepository from '../../organizations/repositories/organizations.membership.repository.js';
import { MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES } from '../../organizations/lib/constants.js';
import { removeSensitive } from '../utils/sanitizeUser.js';

/**
 * @function normalizeEmail
 * @desc Lowercase + trim an email for case-insensitive comparison. MUST stay in sync
 *   with the repository-layer normalization (UserRepository, module-local there) —
 *   duplicated here as a one-liner to keep the layering untouched; if the repository
 *   normalization ever changes (e.g. Unicode fold), update both so the email-change
 *   guard's previous-vs-new comparison cannot drift.
 * @param {string} email - raw email value
 * @returns {string|null} normalized email, or null for a non-string input
 */
const normalizeEmail = (email) => (typeof email === 'string' ? email.toLowerCase().trim() : null);

/**
 * @desc Function to get all users in db
 * @param {String} search
 * @param {Int} page
 * @param {Int} perPage
 * @returns {Promise<Array>} users selected
 */
const list = async (search, page, perPage) => {
  const result = await UserRepository.list(search, page || 0, perPage || 20);
  return result.map((user) => removeSensitive(user));
};

/**
 * @desc Function to ask repository to create a user (define provider, check & hashpassword, save)
 * @param {Object} user
 * @returns {Promise<Object>} created user (sanitized)
 */
const create = async (user) => {
  // Set provider to local
  if (!user.provider) user.provider = 'local';
  // confirming to secure password policies
  if (user.password) {
    // Password-strength validation is enforced at the model layer via its schema refinement/helper.
    // const validPassword = zxcvbn(user.password);
    // if (!validPassword || !validPassword.score || validPassword.score < config.zxcvbn.minimumScore) {
    //   throw new AppError(`${validPassword.feedback.warning}. ${validPassword.feedback.suggestions.join('. ')}`);
    // }
    // When password is provided we need to make sure we are hashing it
    user.password = await AuthService.hashPassword(user.password);
  }
  const result = await UserRepository.create(user);
  // Remove sensitive data before return
  return removeSensitive(result);
};

/**
 * @desc Function to ask repository to search users by request
 * @param {Object} input - mongoose query input
 * @returns {Promise<Array>} matching users (sanitized)
 */
const search = async (input) => {
  const result = await UserRepository.search(input);
  return result.map((user) => removeSensitive(user));
};

/**
 * @desc Function to ask repository to get a user by id or email
 * @param {Object} user - object with id or email field
 * @returns {Promise<Object|null>} sanitized user or null
 */
const get = async (user) => {
  const result = await UserRepository.get(user);
  return removeSensitive(result);
};

/**
 * @desc Function to ask repository to get a user by id or email without filter data return (test & intern usage)
 * @param {Object} user - object with id or email field
 * @returns {Promise<Object|null>} full user document or null
 */
const getBrut = async (user) => {
  const result = await UserRepository.get(user);
  return result;
};

/**
 * @desc Function to ask repository to update a user
 * @param {Object} user - original user document
 * @param {Object} body - fields to update
 * @param {string} [option] - update mode: 'admin', 'recover', or undefined for user self-update
 * @returns {Promise<Object>} updated user (sanitized)
 */
const update = async (user, body, option) => {
  const previousEmail = user.email;
  if (!option) user = _.assignIn(user, removeSensitive(body, config.whitelists.users.update));
  else if (option === 'admin') user = _.assignIn(user, removeSensitive(body, config.whitelists.users.updateAdmin));
  else if (option === 'recover') user = _.assignIn(user, removeSensitive(body, config.whitelists.users.recover));

  // #3825 — an email change through the self ('update') or admin ('updateAdmin')
  // whitelists must invalidate the verified state: a stale emailVerified:true on a
  // brand-new address lets linkProviderByEmail ({ email, emailVerified: true })
  // attach an OAuth identity to an address the account never proved it owns. The
  // 'recover' option is exempt — it is the internal writer that SETS verification
  // state (verifyEmail, signup). Mailer-less deployments are exempt too: signup
  // auto-verifies there by design (trust-any-email), and resetting with no way to
  // send a new verification mail would break OAuth linking with no recovery path.
  // The whitelist only filters the BODY, so the service can set these fields itself.
  let verificationToken = null;
  if (option !== 'recover' && mailer.isConfigured()) {
    const normalizedNew = normalizeEmail(user.email);
    const normalizedPrevious = normalizeEmail(previousEmail);
    if (normalizedNew && normalizedNew !== normalizedPrevious) {
      verificationToken = crypto.randomBytes(20).toString('hex');
      user.emailVerified = false;
      user.emailVerificationToken = verificationToken;
      user.emailVerificationExpires = Date.now() + 24 * 3600000; // 24 hours
    }
  }

  const result = await UserRepository.update(user);

  // Fire-and-forget the re-verification mail to the NEW address (same template and
  // params shape as the signup verification mail). Never blocks or fails the update;
  // re-sends are covered by POST /api/auth/resend-verification.
  if (verificationToken) {
    mailer.sendMail({
      template: 'verify-email',
      to: result.email,
      subject: 'Verify your email address',
      params: {
        displayName: [result.firstName, result.lastName].filter(Boolean).join(' '),
        url: `${getBaseUrl()}/verify-email?token=${verificationToken}`,
        appName: config.app.title,
        appContact: config.app.contact,
      },
    }).catch((err) => logger.warn('users.update: email-change verification email failed', { message: err?.message, stack: err?.stack }));
  }

  return removeSensitive(result);
};

/**
 * @desc Function to ask repository to sign terms for current user
 * @param {Object} user - original user document
 * @returns {Promise<Object>} updated user (sanitized)
 */
const terms = async (user) => {
  user = _.assignIn(user, { terms: new Date() });
  const result = await UserRepository.update(user);
  return removeSensitive(result);
};

/**
 * @desc Function to remove a user from db and clean up associated memberships/orgs
 * @param {Object} user - user document with _id or id field
 * @returns {Promise<Object>} deletion result
 */
const remove = async (user) => {
  const userId = user._id || user.id;

  // Clean up memberships and handle orphaned orgs before deleting the user
  const memberships = await MembershipService.listByUser(userId);
  for (const membership of memberships) {
    const orgId = membership.organizationId._id || membership.organizationId;
    if (membership.role === MEMBERSHIP_ROLES.OWNER) {
      // Check if this user is the only owner of the org
      const ownerCount = await MembershipService.count({ organizationId: orgId, role: MEMBERSHIP_ROLES.OWNER, status: MEMBERSHIP_STATUSES.ACTIVE });
      if (ownerCount <= 1) {
        // Sole owner — delete org and cascade: repair co-member currentOrganization
        // Step 1: Collect co-members whose currentOrganization points to this org
        const affectedUsers = await UserRepository.findWithFilter({ currentOrganization: orgId }, '_id');
        // Step 2: Delete all memberships for this org (including this user's and all co-members')
        await MembershipService.deleteMany({ organizationId: orgId });
        // Step 3: For each affected co-member, switch to their next available org or set null
        await Promise.all(affectedUsers.map(async (u) => {
          const remaining = await MembershipRepository.list({ userId: u._id, status: MEMBERSHIP_STATUSES.ACTIVE });
          const liveMemberships = remaining.filter((m) => m.organizationId != null);
          const nextOrg = liveMemberships.length > 0 ? (liveMemberships[0].organizationId._id || liveMemberships[0].organizationId) : null;
          await UserRepository.updateById(u._id, { currentOrganization: nextOrg });
        }));
        // Step 4: Delete the org (bare remove — org-scoped tasks are intentionally not deleted here)
        await OrganizationsRepository.remove({ _id: orgId });
        continue; // memberships for this org already cleaned up
      }
    }
    // Delete this user's membership
    await MembershipService.deleteMany({ _id: membership._id });
  }

  const result = await UserRepository.remove(user);
  return result;
};

/**
 * @desc Function to get all stats of db
 * @returns {Promise<Object>} user statistics
 */
const stats = async () => {
  const result = await UserRepository.stats();
  return result;
};

/**
 * @desc Exact user count (delegates to repository.count)
 * @param {Object} [filter] - optional Mongoose filter
 * @returns {Promise<number>} exact matching user count
 */
const count = (filter = {}) => UserRepository.count(filter);

/**
 * @desc Function to update a user by ID with a partial update object
 * @param {String} id - The user ID
 * @param {Object} data - Fields to update
 * @returns {Promise<Object>} update result
 */
const updateById = (id, data) => UserRepository.updateById(id, data);

/**
 * @desc Function to find users matching a filter with optional field selection
 * @param {Object} filter - Mongoose filter
 * @param {String} [select] - Fields to select
 * @returns {Promise<Array>} matching users
 */
const findWithFilter = (filter, select) => UserRepository.findWithFilter(filter, select);

/**
 * @desc Function to find a user by ID, update, and return the populated document
 * @param {String} id - The user ID
 * @param {Object} data - Fields to update
 * @param {String|Array|Object} populateFields - Fields to populate
 * @returns {Promise<Object>} updated user
 */
const findByIdAndUpdatePopulated = (id, data, populateFields) => UserRepository.findByIdAndUpdatePopulated(id, data, populateFields);

/**
 * @desc Function to search users by name or email
 * @param {String} search - The search string
 * @returns {Promise<Array>} matching user IDs
 */
const searchByNameOrEmail = (search) => UserRepository.searchByNameOrEmail(search);

/**
 * @desc Function to find a user by email address
 * @param {String} email - The email to search for
 * @returns {Promise<Object|null>} The matching user or null
 */
const findByEmail = (email) => UserRepository.findByEmail(email);

/**
 * @desc Atomically attach an OAuth provider to an existing user matched by email.
 * Uses a single findOneAndUpdate to avoid TOCTOU races between concurrent OAuth callbacks.
 * @param {string} email - The email to match
 * @param {string} provider - The OAuth provider key (e.g. 'google', 'apple')
 * @param {Object} providerData - The provider's identity data to store
 * @returns {Promise<Object|null>} sanitized updated user or null if no match
 */
const linkProviderByEmail = async (email, provider, providerData) => {
  const result = await UserRepository.linkProviderByEmail(email, provider, providerData);
  return result ? removeSensitive(result) : null;
};

export default {
  list,
  create,
  search,
  get,
  getBrut,
  update,
  terms,
  remove,
  stats,
  count,
  updateById,
  findWithFilter,
  findByIdAndUpdatePopulated,
  searchByNameOrEmail,
  findByEmail,
  linkProviderByEmail,
  removeSensitive,
};
