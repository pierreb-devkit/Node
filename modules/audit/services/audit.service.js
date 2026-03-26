/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';
import AuditRepository from '../repositories/audit.repository.js';

/**
 * @function log
 * @description Record an audit log entry. No-op when audit is disabled.
 * @param {Object} params
 * @param {string} params.action - Action identifier (e.g. 'auth.login', 'billing.subscribe')
 * @param {Object} [params.req] - Express request object (extracts userId, orgId, ip, userAgent)
 * @param {string} [params.targetType] - Type of the target entity
 * @param {string} [params.targetId] - ID of the target entity
 * @param {Object} [params.metadata] - Additional metadata
 * @returns {Promise<Object|null>} The created audit log entry or null if disabled
 */
const log = async ({ action, req, targetType, targetId, metadata } = {}) => {
  if (!config.audit?.enabled) return null;
  if (!action) return null;

  const entry = {
    action,
    targetType: targetType || '',
    targetId: targetId || '',
    metadata: metadata || {},
  };

  // Extract context from request if available (coerce ObjectIds to strings)
  if (req) {
    const uid = req.user?._id || req.user?.id;
    const oid = req.organization?._id || req.organization?.id;
    if (uid) entry.userId = String(uid);
    if (oid) entry.orgId = String(oid);
    entry.ip = config.audit?.captureIp !== false ? (req.ip || req.connection?.remoteAddress || '') : '';
    entry.userAgent = config.audit?.captureUserAgent !== false ? (req.headers?.['user-agent'] || '') : '';
  }

  try {
    return await AuditRepository.create(entry);
  } catch (err) {
    // Audit must never break the main flow
    logger.error('AuditLog write failed:', { message: err.message });
    return null;
  }
};

/**
 * @function list
 * @description Fetch paginated audit logs with optional filters.
 * @param {Object} filter - Query filter { action, userId, orgId }
 * @param {number} page - Page number
 * @param {number} perPage - Items per page
 * @returns {Promise<{data: Array<Object>, total: number, page: number, perPage: number}>} Paginated result
 */
const list = async (filter = {}, page = 1, perPage = 20) => {
  // Build clean filter (remove undefined values)
  const cleanFilter = {};
  if (filter.action) cleanFilter.action = filter.action;
  if (filter.userId) cleanFilter.userId = filter.userId;
  if (filter.orgId) cleanFilter.orgId = filter.orgId;

  return AuditRepository.list(cleanFilter, page, perPage);
};

export default {
  log,
  list,
};
