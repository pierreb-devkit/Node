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
});

const ProcessedStripeEventCreate = z.object({
  eventId: z.string().trim().min(1, 'eventId is required'),
  type: z.string().trim().min(1, 'type is required'),
});

export default {
  ProcessedStripeEvent,
  ProcessedStripeEventCreate,
};
