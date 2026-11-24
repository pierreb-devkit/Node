/**
 * Module dependencies
 */
import passport from 'passport';

import MembershipService from '../../organizations/services/organizations.membership.service.js';
import logger from '../../../lib/services/logger.js';

/**
 * Identify the viewer of a public image route without requiring a login.
 * A valid TOKEN cookie sets `req.user`; a missing, bad or expired one leaves the
 * request as a guest (never 401). When the user has a current organization, its
 * active membership is set on `req.membership`; a stale organization or a lookup
 * failure leaves the user without one (never 403/404), so guest-readable kinds
 * still pass and private kinds are refused by the policy.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const optionalAuth = (req, res, next) =>
  passport.authenticate('jwt', { session: false }, async (err, user) => {
    if (!err && user) {
      req.user = user;
      const organizationId = user.currentOrganization?._id || user.currentOrganization;
      if (organizationId) {
        try {
          const membership = await MembershipService.resolveMembership(user, organizationId);
          if (membership) req.membership = membership;
        } catch (lookupErr) {
          logger.warn(`uploads.optionalAuth - membership lookup failed: ${lookupErr.message}`);
        }
      }
    }
    next();
  })(req, res, next);

export default optionalAuth;
