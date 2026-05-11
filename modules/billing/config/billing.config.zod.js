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
 *   signupGrant — one-time credit granted to fresh orgs at signup (positive integer).
 *                 Must be present when oneShot is set.
 *   oneShot     — when true the grant does not renew on weekly/monthly reset.
 *                 Must be present when signupGrant is set.
 *   version     — plan version string (YYYY.MM or v${N}); falls back to meter.ratioVersion
 */
const billingPlanDefinitionSchema = z
  .object({
    planId: z.string().min(1),
    meterQuota: z.number().int().nonnegative(),
    ratios: z.record(z.string(), z.number()).default(() => ({})),
    version: z.string().optional(),
    signupGrant: z.number().int().positive().optional(),
    oneShot: z.boolean().optional(),
  })
  .refine(
    (data) => (data.signupGrant !== undefined) === (data.oneShot !== undefined),
    {
      message:
        'signupGrant and oneShot must be defined together — set both or neither',
      path: ['signupGrant'],
    },
  );

export { billingPlanDefinitionSchema };
