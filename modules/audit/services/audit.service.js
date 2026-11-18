/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import AuditRepository from '../repositories/audit.repository.js';
import { DEFAULT_WEEKS, WEEK_MS, weeklyWindowStart, fillWeeks } from '../../../lib/helpers/weeklyStats.js';

/** Weeks in the current period the activity KPIs compare (the previous period has the same length). */
const PERIOD_WEEKS = 4;

/** Number of actions listed in the stats. */
const TOP_ACTIONS = 5;

/**
 * @function log
 * @description Record an audit log entry. No-op when audit is disabled.
 * @param {Object} [params]
 * @param {string} [params.action] - Action identifier (no-op when missing) (e.g. 'auth.login', 'billing.subscribe')
 * @param {string} [params.userId] - ID of the acting user
 * @param {string} [params.organizationId] - ID of the organization context
 * @param {string} [params.ip] - IP address of the request
 * @param {string} [params.userAgent] - User-agent of the request
 * @param {string} [params.targetType] - Type of the target entity
 * @param {string} [params.targetId] - ID of the target entity
 * @param {Object} [params.metadata] - Additional metadata
 * @returns {Promise<Object|null>} The created audit log entry, or null if disabled
 * @throws {Error} If `AuditRepository.create` fails — propagated so the caller's
 *   own `.catch()` can log with its request context (action, userId, orgId,
 *   targetType, ...). Audit must never break the main flow — that guarantee is
 *   enforced by the caller's `.catch()` (see `audit.middleware.js`), not by
 *   swallowing the write failure here.
 */
const log = async ({ action, userId, organizationId, ip, userAgent, targetType, targetId, metadata } = {}) => {
  if (!config.audit?.enabled) return null;
  if (!action) return null;

  const entry = {
    action,
    targetType: targetType || '',
    targetId: targetId || '',
    metadata: metadata || {},
  };

  if (userId) entry.userId = String(userId);
  if (organizationId) entry.orgId = String(organizationId);
  if (ip !== undefined) entry.ip = ip || '';
  if (userAgent !== undefined) entry.userAgent = userAgent || '';

  return AuditRepository.create(entry);
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

/**
 * @function adminStats
 * @description Activity stats for the admin overview: entries per week over the
 *   last DEFAULT_WEEKS weeks, the most frequent actions in that window, and the
 *   distinct acting accounts in the last PERIOD_WEEKS finished weeks vs the PERIOD_WEEKS before
 *   (the unfinished current week is left out of the KPI).
 *   Entries older than the audit TTL are gone, so the window never reaches past it.
 * @returns {Promise<{total: number, weeks: Array<{week: string, count: number}>, topActions: Array<{action: string, count: number}>, activeUsers: {current: number, previous: number, periodWeeks: number}}>}
 */
const adminStats = async () => {
  const start = weeklyWindowStart(DEFAULT_WEEKS);
  const windowEnd = new Date(start.getTime() + DEFAULT_WEEKS * WEEK_MS);
  // KPI periods use finished weeks only: the unfinished current week is left out.
  const finishedEnd = new Date(start.getTime() + (DEFAULT_WEEKS - 1) * WEEK_MS);
  const currentStart = new Date(finishedEnd.getTime() - PERIOD_WEEKS * WEEK_MS);
  const previousStart = new Date(currentStart.getTime() - PERIOD_WEEKS * WEEK_MS);
  const [rows, topActions, active] = await Promise.all([
    AuditRepository.weeklyCount(start),
    AuditRepository.topActions(start, windowEnd, TOP_ACTIONS),
    AuditRepository.activeUsers(previousStart, currentStart, finishedEnd),
  ]);
  const weeks = fillWeeks(rows, start, DEFAULT_WEEKS);
  return {
    total: weeks.reduce((sum, w) => sum + w.count, 0),
    weeks,
    topActions,
    activeUsers: { ...active, periodWeeks: PERIOD_WEEKS },
  };
};

export default {
  log,
  list,
  adminStats,
};
