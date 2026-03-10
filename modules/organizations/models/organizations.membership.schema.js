/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * Data Schema
 */
const MembershipInvite = z.object({
  email: z.string().trim().email(),
  role: z.enum(['admin', 'member']).default('member'),
});

const MembershipUpdate = z.object({
  role: z.enum(['owner', 'admin', 'member']),
});

export default {
  MembershipInvite,
  MembershipUpdate,
};
