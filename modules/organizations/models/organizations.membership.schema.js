/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * Data Schema
 */
const MembershipUpdate = z.object({
  role: z.enum(['owner', 'admin', 'member']),
});

/**
 * Owner/admin add-member payload. `userId` is the target user's id (required —
 * the user must already exist; resolve from an email via the /members/search
 * lookup first). `role` is the role to grant on acceptance (defaults to member).
 */
const MembershipAdd = z.object({
  userId: z.string().min(1),
  role: z.enum(['owner', 'admin', 'member']).optional(),
});

export default {
  MembershipUpdate,
  MembershipAdd,
};
