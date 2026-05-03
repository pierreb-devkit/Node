/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * BillingMeterOutbox Zod schema — mirrors billing.meter.outbox.model.mongoose.js
 */

const objectIdRegex = /^[a-f\d]{24}$/i;

const BillingMeterOutboxStatus = z.enum(['pending', 'committed', 'failed']);

const BillingMeterOutbox = z.object({
  organizationId: z.string().trim().regex(objectIdRegex, 'organizationId must be a valid ObjectId'),
  idempotencyKey: z.string().trim().min(1, 'idempotencyKey is required'),
  extrasUnits: z.number().int().min(1, 'extrasUnits must be >= 1'),
  status: BillingMeterOutboxStatus.default('pending'),
  attempts: z.number().int().min(0).default(0),
  lastError: z.string().nullable().default(null),
  lastAttemptedAt: z.coerce.date().nullable().default(null),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

const BillingMeterOutboxCreate = z.object({
  organizationId: z.string().trim().regex(objectIdRegex, 'organizationId must be a valid ObjectId'),
  idempotencyKey: z.string().trim().min(1, 'idempotencyKey is required'),
  extrasUnits: z.number().int().min(1, 'extrasUnits must be >= 1'),
});

export default {
  BillingMeterOutboxStatus,
  BillingMeterOutbox,
  BillingMeterOutboxCreate,
};
