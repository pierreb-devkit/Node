/**
 * Module dependencies
 */
import isGlobalAdmin from '../../../lib/helpers/isGlobalAdmin.js';
import { MEMBERSHIP_ROLES } from './organizations.constants.js';

/**
 * @function canManageMembers
 * @description Whether the actor may bring people into an organization (add a member,
 *   look a user up, send an organization invitation): a platform admin, or an OWNER /
 *   ADMIN of that organization. `membership` is the actor's own ACTIVE membership in the
 *   target organization (null for a non-member).
 * @param {Object} user - The authenticated actor (req.user).
 * @param {Object|null} membership - The actor's membership in the target organization.
 * @returns {boolean} True when the actor may manage members.
 */
export const canManageMembers = (user, membership) =>
  isGlobalAdmin(user)
  || membership?.role === MEMBERSHIP_ROLES.OWNER
  || membership?.role === MEMBERSHIP_ROLES.ADMIN;

/**
 * @function canGrantRole
 * @description Role ceiling for adding or inviting someone: anyone allowed to manage
 *   members may grant `member`; only an OWNER (or a platform admin) may grant an
 *   elevated role (`admin` / `owner`).
 * @param {Object} user - The authenticated actor (req.user).
 * @param {Object|null} membership - The actor's membership in the target organization.
 * @param {string} role - The role to grant.
 * @returns {boolean} True when the actor may grant this role.
 */
export const canGrantRole = (user, membership, role) =>
  role === MEMBERSHIP_ROLES.MEMBER
  || isGlobalAdmin(user)
  || membership?.role === MEMBERSHIP_ROLES.OWNER;

export default { canManageMembers, canGrantRole };
