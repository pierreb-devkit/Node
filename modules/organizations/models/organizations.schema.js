/**
 * Module dependencies
 */
import { z } from 'zod';

import config from '../../../config/index.js';

/**
 * Data Schema
 */
const Organization = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().default(''),
  slug: z.string().trim().min(1).toLowerCase().optional(),
  domain: z.string().trim().default(''),
  plan: z.enum(config.billing.plans).default('free'),
  meterExempt: z.boolean().default(false).optional(),
});

const OrganizationUpdate = Organization.partial();

export default {
  Organization,
  OrganizationUpdate,
};
