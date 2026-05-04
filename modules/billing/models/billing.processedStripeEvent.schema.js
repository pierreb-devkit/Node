/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * ProcessedStripeEvent Zod schema — mirrors billing.processedStripeEvent.model.mongoose.js
 */

const ProcessedStripeEvent = z.object({
  eventId: z.string().trim().min(1, 'eventId is required'),
  type: z.string().trim().min(1, 'type is required'),
  processedAt: z.coerce.date().default(() => new Date()),
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().nullable().optional(),
  lastErrorAt: z.coerce.date().nullable().optional(),
  deadLetter: z.boolean().default(false),
});

const ProcessedStripeEventCreate = z.object({
  eventId: z.string().trim().min(1, 'eventId is required'),
  type: z.string().trim().min(1, 'type is required'),
});

export default {
  ProcessedStripeEvent,
  ProcessedStripeEventCreate,
};
