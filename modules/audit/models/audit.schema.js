/**
 * Module dependencies
 */
import { z } from 'zod';

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

/**
 * AuditLog Zod schemas
 */
const AuditLog = z.object({
  action: z.string().trim().min(1),
  userId: z.string().trim().regex(objectIdRegex, 'must be a valid ObjectId').optional(),
  orgId: z.string().trim().regex(objectIdRegex, 'must be a valid ObjectId').optional(),
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
  action: z.string().trim().min(1).optional(),
  userId: z.string().trim().regex(objectIdRegex, 'must be a valid ObjectId').optional(),
  orgId: z.string().trim().regex(objectIdRegex, 'must be a valid ObjectId').optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

export default {
  AuditLog,
  AuditQuery,
};
