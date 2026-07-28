/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * BillingUsage Zod schema — mirrors billing.usage.model.mongoose.js
 *
 * Legacy fields (organizationId, month, counters) are always required.
 * Meter fields (weekKey, consumedAttributionKeys, etc.) are optional to preserve
 * backward compatibility with non-meter downstream projects.
 */
const objectIdRegex = /^[a-f\d]{24}$/i;

/**
 * Attribution key regex: accepts raw ObjectId (legacy) or `${id}:${stepKey}` format.
 * stepKey may contain alphanumeric chars, colons, hyphens, underscores (1-64 chars).
 */
const attributionKeyRegex = /^[a-fA-F0-9]{24}(:[a-zA-Z0-9:_-]{1,64})?$/;

const BillingUsage = z.object({
  organizationId: z.string().trim().regex(objectIdRegex, 'organizationId must be a valid ObjectId'),
  month: z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be in YYYY-MM format'),
  counters: z.record(z.string(), z.number()).default(() => ({})),

  /**
   * Discriminator set only on legacy (non-meter) usage documents — see the
   * model field comment. Never set on meter-mode (weekKey-keyed) documents.
   */
  legacyPeriod: z.boolean().optional(),

  // ── Meter fields (optional — only populated in meter mode) ───────────────

  /**
   * ISO week key "YYYY-Www" (e.g. "2026-W18").
   * Week numbers 01-53 as per ISO 8601.
   */
  weekKey: z
    .string()
    .trim()
    .regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, 'weekKey must be in YYYY-Www format (W01-W53)')
    .optional(),

  meterUsed: z.number().min(0).default(0),
  meterQuota: z.number().min(0).default(0),
  planVersion: z.string().trim().optional(),
  meterBreakdown: z.record(z.string(), z.number()).default(() => ({})),
  resetAt: z.coerce.date().optional().nullable(),
  alertedAt80: z.coerce.date().optional().nullable(),
  alertedAt100: z.coerce.date().optional().nullable(),
  archivedAt: z.coerce.date().optional().nullable(),

  /**
   * Per-step attribution keys consumed this period.
   * Format: `${historyId}:${stepKey}` (e.g. "507f1f77bcf86cd799439011:initial").
   * Legacy raw ObjectId strings are also accepted for backward compatibility.
   */
  consumedAttributionKeys: z
    .array(
      z
        .string()
        .trim()
        .regex(
          attributionKeyRegex,
          'consumedAttributionKeys entries must be <objectId> or <objectId>:<stepKey>',
        ),
    )
    .default(() => []),
});

export default {
  BillingUsage,
};
