/**
 * Module dependencies
 */
import { z } from 'zod';

import { MEMBERSHIP_ROLES } from '../lib/constants.js';

const MembershipRole = z.enum(Object.values(MEMBERSHIP_ROLES));

/**
 * Data Schema
 */
const MembershipUpdate = z.object({
  role: MembershipRole,
});

/**
 * Owner/admin add-member payload. `userId` is the target user's id (required —
 * the user must already exist; resolve from an email via the /members/search
 * lookup first). `role` is the role to grant on acceptance (defaults to member).
 */
const MembershipAdd = z.object({
  userId: z.string().min(1),
  role: MembershipRole.optional(),
});

/**
 * Member list query (`GET /api/organizations/:organizationId/members`).
 * `page` is 0-based; no `perPage` means the list is not paginated. An empty
 * `search` reads as absent.
 */
const MembershipListQuery = z.object({
  page: z.coerce.number().int().min(0).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().max(200).optional().transform((value) => value || undefined),
});

export default {
  MembershipUpdate,
  MembershipAdd,
  MembershipListQuery,
};
