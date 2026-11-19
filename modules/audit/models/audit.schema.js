/**
 * Module dependencies
 */
import { z } from 'zod';
import { objectIdRegex, pageQuery } from '../../../lib/helpers/zod.js';

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
const AuditQuery = pageQuery({ defaultSize: 20 }).extend({
  action: z.string().trim().min(1).optional(),
  userId: z.string().trim().regex(objectIdRegex, 'must be a valid ObjectId').optional(),
  orgId: z.string().trim().regex(objectIdRegex, 'must be a valid ObjectId').optional(),
});

export default {
  AuditLog,
  AuditQuery,
};
