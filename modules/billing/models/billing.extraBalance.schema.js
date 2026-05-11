/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * BillingExtraBalance Zod schema — mirrors billing.extraBalance.model.mongoose.js
 */

const objectIdRegex = /^[a-f\d]{24}$/i;

/**
 * Ledger entry kinds enum — mirrors the Mongoose enum.
 */
const LedgerKind = z.enum(['topup', 'debit', 'refund', 'expiration', 'adjustment']);

/**
 * Allowed grant sources — mirrors the Mongoose enum on LedgerEntrySchema.source.
 * 'signup_grant' — one-shot free tier grant on org creation.
 * 'adjustment'   — manual ops credit (non-Stripe, no Stripe session).
 * NOTE: 'adjustment' here is a source tag (who credited it), distinct from
 * LedgerKind 'adjustment' (how the balance was changed). They share the string
 * literal by convention: a manual adjustment uses kind='adjustment' + source='adjustment'.
 * Grant entries use kind='topup' + source='signup_grant'.
 */
const GrantSource = z.enum(['signup_grant', 'adjustment']);

/**
 * Single ledger entry schema.
 * Enforces:
 *   - amount !== 0 (zero is always a bug)
 *   - sign by kind: topup/adjustment must be > 0; debit/expiration/refund must be < 0
 */
const LedgerEntry = z
  .object({
    _id: z.string().trim().regex(objectIdRegex, '_id must be a valid ObjectId').optional(),
    kind: LedgerKind,
    /**
     * Signed amount in meter units.
     * Positive for topup/adjustment; negative for debit/expiration/refund.
     * 'refund' entries are clawbacks (negative) reflecting reclaimed units.
     * Zero is rejected as an operational guard (zero-amount entries are always a bug).
     */
    amount: z.number().refine((n) => n !== 0, { message: 'Ledger entry amount must not be zero' }),
    stripeSessionId: z.string().trim().optional().nullable(),
    historyId: z
      .string()
      .trim()
      .regex(objectIdRegex, 'historyId must be a valid ObjectId')
      .optional()
      .nullable(),
    refId: z.string().trim().optional().nullable(),
    /**
     * Credit source tag — set on grant/adjustment entries; absent on Stripe topup entries.
     * Mirrors LedgerEntrySchema.source in billing.extraBalance.model.mongoose.js.
     */
    source: GrantSource.optional().nullable(),
    at: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional().nullable(),
  })
  .superRefine((entry, ctx) => {
    const { kind, amount } = entry;
    if (kind === 'topup' || kind === 'adjustment') {
      if (amount <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Ledger entry of kind '${kind}' must have a positive amount`,
          path: ['amount'],
        });
      }
    } else if (kind === 'debit' || kind === 'expiration' || kind === 'refund') {
      if (amount >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Ledger entry of kind '${kind}' must have a negative amount`,
          path: ['amount'],
        });
      }
    }
  });

/**
 * Full ExtraBalance document schema.
 */
const BillingExtraBalance = z.object({
  organization: z.string().trim().regex(objectIdRegex, 'organization must be a valid ObjectId'),
  ledger: z.array(LedgerEntry).default(() => []),
  cachedBalance: z.number().default(0),
  cachedBalanceAt: z.coerce.date().optional(),
});

/**
 * Schema for creditPack input.
 */
const ExtraBalanceCreditPack = z.object({
  orgId: z.string().trim().regex(objectIdRegex, 'orgId must be a valid ObjectId'),
  amount: z.number().int().min(1, 'amount must be >= 1'),
  stripeSessionId: z.string().trim().min(1, 'stripeSessionId is required'),
  expiresAt: z.coerce.date().optional().nullable(),
});

/**
 * Schema for debit input.
 */
const ExtraBalanceDebit = z.object({
  orgId: z.string().trim().regex(objectIdRegex, 'orgId must be a valid ObjectId'),
  amount: z.number().int().min(1, 'amount must be >= 1'),
  refId: z.string().trim().min(1, 'refId is required'),
});

/**
 * Schema for creditGrant input.
 * Unlike creditPack, no stripeSessionId is required — idempotency is
 * derived from `source + orgId` (synthetic key stored as refId).
 */
const ExtraBalanceCreditGrant = z.object({
  orgId: z.string().trim().regex(objectIdRegex, 'orgId must be a valid ObjectId'),
  amount: z.number().int().min(1, 'amount must be >= 1'),
  source: GrantSource,
});

export default {
  LedgerKind,
  GrantSource,
  LedgerEntry,
  BillingExtraBalance,
  ExtraBalanceCreditPack,
  ExtraBalanceDebit,
  ExtraBalanceCreditGrant,
};
