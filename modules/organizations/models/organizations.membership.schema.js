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

export default {
  MembershipUpdate,
};
