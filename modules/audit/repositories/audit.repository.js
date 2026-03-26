/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import AuditSchema from '../models/audit.schema.js';

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

export default {
  create,
  list,
  deleteMany,
};
