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
  computeQuota: z.number().int().min(0, 'computeQuota must be >= 0'),
  stripePriceMonthly: z.string().trim().optional().nullable(),
  stripePriceAnnual: z.string().trim().optional().nullable(),
  ratios: z.record(z.string(), z.number()).default(() => ({})),
  effectiveFrom: z.coerce.date(),
  effectiveUntil: z.coerce.date().nullable().optional(),
  active: z.boolean().default(true),
});

/**
 * Schema for bumping to a new plan version.
 * computeQuota and ratios are required; other fields are optional overrides.
 */
const BillingPlanBump = z
  .object({
    computeQuota: z.number().int().min(0),
    ratios: z.record(z.string(), z.number()).optional(),
    stripePriceMonthly: z.string().trim().optional().nullable(),
    stripePriceAnnual: z.string().trim().optional().nullable(),
  })
  .strict();

export default {
  BillingPlan,
  BillingPlanBump,
};
