/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * Supported webhook event types
 */
const supportedEvents = ['scrap.success', 'scrap.failure', 'scrap.created', 'scrap.deleted'];

/**
 * Data Schema
 */
const WebhookCreate = z
  .object({
    url: z.string().trim().url('url must be a valid URL').startsWith('https://', 'url must use HTTPS'),
    events: z
      .array(z.enum(supportedEvents))
      .min(1, 'at least one event is required'),
    description: z.string().max(200, 'description must be at most 200 characters').optional(),
  })
  .strict();

const WebhookUpdate = z
  .object({
    url: z.string().trim().url('url must be a valid URL').startsWith('https://', 'url must use HTTPS').optional(),
    events: z
      .array(z.enum(supportedEvents))
      .min(1, 'at least one event is required')
      .optional(),
    active: z.boolean().optional(),
    description: z.string().max(200, 'description must be at most 200 characters').optional(),
  })
  .strict();

export { supportedEvents };

export default {
  WebhookCreate,
  WebhookUpdate,
  supportedEvents,
};
