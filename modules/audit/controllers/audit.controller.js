/**
 * Module dependencies
 */
import responses from '../../../lib/helpers/responses.js';
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
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

export default {
  list,
};
