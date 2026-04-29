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
 * Single ledger entry schema.
 */
const LedgerEntry = z.object({
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
  at: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional().nullable(),
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

export default {
  LedgerKind,
  LedgerEntry,
  BillingExtraBalance,
  ExtraBalanceCreditPack,
  ExtraBalanceDebit,
};
