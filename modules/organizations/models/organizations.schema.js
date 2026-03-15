/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * Data Schema
 */
const Organization = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().default(''),
  slug: z.string().trim().min(1).toLowerCase().optional(),
  domain: z.string().trim().default(''),
  plan: z.enum(['free', 'starter', 'pro', 'enterprise']).default('free'),
});

const OrganizationUpdate = Organization.partial();

export default {
  Organization,
  OrganizationUpdate,
};
