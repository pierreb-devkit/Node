/**
 * Module dependencies
 */
import responses from '../../../lib/helpers/responses.js';
import logger from '../../../lib/services/logger.js';
import errors from '../../../lib/helpers/errors.js';
import AuditService from '../services/audit.service.js';
import AuditSchema from '../models/audit.schema.js';

/**
 * @function list
 * @description Endpoint to fetch paginated audit logs (admin only).
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const list = async (req, res) => {
  try {
    const parsed = AuditSchema.AuditQuery.safeParse(req.query);
    if (!parsed.success) {
      return responses.error(res, 400, 'Bad Request', 'Invalid query parameters')(parsed.error);
    }
    const query = parsed.data;

    const result = await AuditService.list(
      { action: query.action, userId: query.userId, orgId: query.orgId },
      query.page,
      query.perPage,
    );
    responses.success(res, 'audit log list')(result);
  } catch (err) {
    responses.error(res, undefined, undefined, errors.getMessage(err))(err);
  }
};

/**
 * @function stats
 * @description Endpoint returning activity stats for the admin overview (admin only).
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const stats = async (req, res) => {
  try {
    const data = await AuditService.adminStats();
    responses.success(res, 'audit stats')(data);
  } catch (err) {
    logger.error('[stats] audit stats failed', { message: err?.message, stack: err?.stack });
    responses.error(res, undefined, undefined, 'Unable to compute audit stats')(err);
  }
};

export default {
  list,
  stats,
};
