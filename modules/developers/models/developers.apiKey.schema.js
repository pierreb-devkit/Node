/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * Data Schema
 */
const ApiKeyCreate = z
  .object({
    name: z.string().trim().min(1, 'name is required').max(100, 'name must be at most 100 characters'),
    scopes: z.array(z.enum(['read', 'write'])).default(['read']),
    expiresAt: z.coerce.date().optional(),
  })
  .strict();

export default {
  ApiKeyCreate,
};
