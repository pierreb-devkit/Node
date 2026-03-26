/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * AuditLog Zod schemas
 */
const AuditLog = z.object({
  action: z.string().trim().min(1),
  userId: z.string().trim().optional(),
  orgId: z.string().trim().optional(),
  targetType: z.string().trim().default(''),
  targetId: z.string().trim().default(''),
  ip: z.string().trim().default(''),
  userAgent: z.string().trim().default(''),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Query filter schema for list endpoint
 */
const AuditQuery = z.object({
  action: z.string().trim().optional(),
  userId: z.string().trim().optional(),
  orgId: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

export default {
  AuditLog,
  AuditQuery,
};
