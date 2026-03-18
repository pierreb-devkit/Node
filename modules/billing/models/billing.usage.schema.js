/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 *  Data Schema
 */
const objectIdRegex = /^[a-f\d]{24}$/i;

const BillingUsage = z.object({
  organizationId: z.string().trim().regex(objectIdRegex, 'organizationId must be a valid ObjectId'),
  month: z.string().trim().regex(/^\d{4}-\d{2}$/, 'month must be in YYYY-MM format'),
  counters: z.record(z.string(), z.number()).default(() => ({})),
});

export default {
  BillingUsage,
};
