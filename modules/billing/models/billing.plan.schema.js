/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * BillingPlan Zod schema — mirrors billing.plan.model.mongoose.js
 */

const BillingPlan = z.object({
  planId: z.string().trim().min(1, 'planId is required'),
  version: z.string().trim().min(1, 'version is required'),
  meterQuota: z.number().int().min(0, 'meterQuota must be >= 0'),
  stripePriceMonthly: z.string().trim().optional().nullable(),
  stripePriceAnnual: z.string().trim().optional().nullable(),
  ratios: z.record(z.string(), z.number().min(0, 'ratio values must be >= 0')).default(() => ({})),
  effectiveFrom: z.coerce.date(),
  effectiveUntil: z.coerce.date().nullable().optional(),
  active: z.boolean().default(true),
});

/**
 * Schema for bumping to a new plan version.
 * meterQuota is required; all other fields are optional overrides.
 */
const BillingPlanBump = z
  .object({
    meterQuota: z.number().int().min(0),
    ratios: z.record(z.string(), z.number()).optional(),
    stripePriceMonthly: z.string().trim().optional().nullable(),
    stripePriceAnnual: z.string().trim().optional().nullable(),
  })
  .strict();

export default {
  BillingPlan,
  BillingPlanBump,
};
