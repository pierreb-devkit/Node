/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import responses from '../helpers/responses.js';

const Organization = mongoose.model('Organization');
const Membership = mongoose.model('Membership');

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
 * @returns {void}
 */
async function resolveOrganization(req, res, next) {
  const organizationId = req.params.organizationId || req.user?.currentOrganization;

  if (!organizationId) return next(); // No org context — allow for backward compat

  try {
    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return responses.error(res, 404, 'Not Found', 'No Organization with that identifier has been found')();
    }

    req.organization = organization;

    // Platform admin bypasses membership requirement
    if (req.user && req.user.roles && req.user.roles.includes('admin')) {
      req.membership = { role: 'owner', organizationId: organization._id };
      return next();
    }

    // Load membership for the current user
    const membership = await Membership.findOne({
      userId: req.user._id,
      organizationId: organization._id,
    });

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
