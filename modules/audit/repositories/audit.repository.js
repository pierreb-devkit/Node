/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import AuditSchema from '../models/audit.schema.js';
import { weeklyCountPipeline } from '../../../lib/helpers/weeklyStats.js';

/**
 * Lazy model accessor — avoids MissingSchemaError when audit.repository.js
 * is transitively imported before Mongoose models are loaded (e.g. in
 * unit tests that mock the billing controller which imports audit service).
 * @returns {import('mongoose').Model}
 */
const getModel = () => mongoose.model('AuditLog');

/**
 * Validate an audit log entry against the Zod schema.
 * @param {Object} data - Raw audit log data
 * @returns {{ success: boolean, data?: Object, error?: import('zod').ZodError }} Parse result
 */
const validate = (data) => AuditSchema.AuditLog.safeParse(data);

/**
 * @function create
 * @description Create a new audit log entry after schema validation.
 * @param {Object} data - Audit log data
 * @returns {Promise<Object>} The created audit log entry
 * @throws {Error} When schema validation fails
 */
const create = (data) => {
  const parsed = validate(data);
  if (!parsed.success) {
    /** @type {Error & {validationErrors?: Object}} */
    const err = new Error('AuditLog validation failed');
    err.validationErrors = parsed.error.flatten();
    throw err;
  }
  return new (getModel())(parsed.data).save();
};

/**
 * @function list
 * @description Fetch paginated audit log entries with optional filters.
 * @param {Object} filter - Query filter (action, userId, orgId)
 * @param {number} page - Page number (1-based)
 * @param {number} perPage - Items per page
 * @returns {Promise<{data: Array, total: number, page: number, perPage: number}>}
 */
const list = async (filter, page, perPage) => {
  const AuditLog = getModel();
  const skip = (page - 1) * perPage;
  const [data, total] = await Promise.all([
    AuditLog.find(filter).sort('-createdAt').skip(skip).limit(perPage).exec(),
    AuditLog.countDocuments(filter).exec(),
  ]);
  return { data, total, page, perPage };
};

/**
 * @function deleteMany
 * @description Delete multiple audit log entries based on a filter.
 * @param {Object} filter - The filter to apply
 * @returns {Promise<Object>} Deletion result
 */
const deleteMany = (filter) => {
  if (!filter || Object.keys(filter).length === 0) {
    // Require explicit filter to prevent accidental full collection wipe
    return Promise.resolve({ deletedCount: 0 });
  }
  return getModel().deleteMany(filter).exec();
};

/**
 * @function weeklyCount
 * @description Count audit entries per week since `start`.
 * @param {Date} start - window start (Monday 00:00 UTC)
 * @returns {Promise<Array<{_id: number, count: number}>>} sparse weekly rows
 */
const weeklyCount = (start) => getModel().aggregate(weeklyCountPipeline(start)).exec();

/**
 * @function topActions
 * @description Most frequent actions since `start`.
 * @param {Date} start - window start (inclusive)
 * @param {Date} end - window end (exclusive)
 * @param {number} limit - number of actions to return
 * @returns {Promise<Array<{action: string, count: number}>>} actions, most frequent first
 */
const topActions = (start, end, limit) =>
  getModel()
    .aggregate([
      { $match: { createdAt: { $gte: start, $lt: end } } },
      { $group: { _id: '$action', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: limit },
      { $project: { _id: 0, action: '$_id', count: 1 } },
    ])
    .exec();

/**
 * @function activeUsers
 * @description Distinct acting users in [previousStart, currentStart) and [currentStart, end).
 * @param {Date} previousStart - start of the previous period
 * @param {Date} currentStart - start of the current period
 * @param {Date} end - end of the current period (exclusive)
 * @returns {Promise<{current: number, previous: number}>} distinct user counts
 */
const activeUsers = async (previousStart, currentStart, end) => {
  const rows = await getModel()
    .aggregate([
      { $match: { createdAt: { $gte: previousStart, $lt: end }, userId: { $exists: true, $ne: null } } },
      { $group: { _id: { userId: '$userId', current: { $gte: ['$createdAt', currentStart] } } } },
      { $group: { _id: '$_id.current', count: { $sum: 1 } } },
    ])
    .exec();
  const byPeriod = new Map(rows.map((r) => [r._id, r.count]));
  return { current: byPeriod.get(true) || 0, previous: byPeriod.get(false) || 0 };
};

export default {
  create,
  list,
  deleteMany,
  weeklyCount,
  topActions,
  activeUsers,
};
