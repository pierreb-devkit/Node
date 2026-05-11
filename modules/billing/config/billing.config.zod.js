/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * @desc Zod schema for a single entry in config.billing.planDefinitions.
 *
 * Required fields:
 *   planId     — logical plan identifier (e.g. "free", "growth", "pro")
 *   meterQuota — compute units per reset period (0 = no periodic quota)
 *   ratios     — feature multiplier map (e.g. { default: 1, autofix: 2 })
 *
 * Optional fields (N2 signup-grant):
 *   signupGrant — one-time credit amount given on org creation (non-negative integer)
 *   oneShot     — when true the grant does not renew on weekly/monthly reset
 *   version     — plan version string (YYYY.MM or v${N}); falls back to meter.ratioVersion
 */
const billingPlanDefinitionSchema = z.object({
  planId: z.string().min(1),
  meterQuota: z.number().int().nonnegative(),
  ratios: z.record(z.string(), z.number()).default(() => ({})),
  version: z.string().optional(),
  signupGrant: z.number().int().nonnegative().optional(),
  oneShot: z.boolean().optional(),
});

export { billingPlanDefinitionSchema };
