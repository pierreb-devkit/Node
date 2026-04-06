/**
 * Module dependencies
 */
import OrganizationsCrudService from '../services/organizations.crud.service.js';
import MembershipService from '../services/organizations.membership.service.js';
import responses from '../../../lib/helpers/responses.js';
import { MEMBERSHIP_ROLES } from '../lib/constants.js';

/**
 * Middleware that resolves the current organization from a route param or
 * the authenticated user's currentOrganization field.
 * When an organization context is found, the Organization document and the
 * user's Membership document are loaded and injected onto the request as
 * `req.organization` and `req.membership`.
 * Platform admins bypass the membership check and receive a synthetic
 * owner-level membership object.
 * If no organization context is present the middleware passes through
 * silently to preserve backward compatibility.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Promise<void>}
 */
async function resolveOrganization(req, res, next) {
  const organizationId = req.params.organizationId || req.user?.currentOrganization;

  if (!organizationId) return next(); // No org context — allow for backward compat

  try {
    const organization = await OrganizationsCrudService.get(organizationId);
    if (!organization) {
      return responses.error(res, 404, 'Not Found', 'No Organization with that identifier has been found')();
    }

    req.organization = organization;

    // Platform admin bypasses membership requirement
    if (req.user && req.user.roles && req.user.roles.includes('admin')) {
      req.membership = { role: MEMBERSHIP_ROLES.OWNER, organizationId: organization._id };
      return next();
    }

    // Load membership for the current user
    if (!req.user) {
      return responses.error(res, 401, 'Unauthorized', 'Authentication required')();
    }
    const membership = await MembershipService.findByUserAndOrganization(req.user._id, organization._id);

    if (!membership) {
      return responses.error(res, 403, 'Forbidden', 'User is not a member of this organization')();
    }

    req.membership = membership;
    return next();
  } catch (err) {
    return next(err);
  }
}

export default {
  resolveOrganization,
};
