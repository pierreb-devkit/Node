/**
 * Module dependencies
 */
import { z } from 'zod';

import { MEMBERSHIP_ROLES } from '../../organizations/lib/organizations.constants.js';

/**
 * Admin create payload — only email is client-supplied; token/expiry are server-set.
 */
const Invitation = z.object({
  email: z.string().email(),
});

/**
 * Organization invite payload (`POST /api/organizations/:organizationId/invitations`) —
 * the email and the role granted on join (default member). The organization comes from
 * the route, never the body.
 */
const OrganizationInvitation = z.object({
  email: z.string().email(),
  role: z.enum(Object.values(MEMBERSHIP_ROLES)).optional(),
});

export default { Invitation, OrganizationInvitation };
