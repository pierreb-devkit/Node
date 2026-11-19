/**
 * Module dependencies
 */
import { z } from 'zod';
import zxcvbn from 'zxcvbn';
import config from '../../config/index.js';

/**
 * A 24-hex-character MongoDB ObjectId string (either case).
 * @type {RegExp}
 */
const objectIdRegex = /^[0-9a-fA-F]{24}$/;

/**
 * @desc True when the value, as a string, is a 24-hex-character ObjectId
 *   (an ObjectId instance passes too, like `RegExp.test` on it would).
 * @param {unknown} value - Candidate id.
 * @returns {boolean} Whether the value is an ObjectId string.
 */
const isObjectId = (value) => objectIdRegex.test(String(value));

/**
 * @desc Zod schema for an ObjectId string.
 * @param {string} [message] - Validation message.
 * @returns {import('zod').ZodString} The schema.
 */
const objectId = (message = 'must be a valid ObjectId') => z.string().regex(objectIdRegex, message);

/**
 * @desc Pagination query fields (`page` + a page-size key), the one schema every
 *   paginated list builds on. Values are coerced from query strings. Without
 *   `defaultSize` both fields are optional (no size = not paginated); with it, both
 *   default (`page` to `firstPage`, the size to `defaultSize`).
 * @param {Object} [options]
 * @param {number} [options.firstPage=1] - Index of the first page (0 or 1).
 * @param {string} [options.sizeKey='perPage'] - Name of the page-size field.
 * @param {number} [options.defaultSize] - Default page size.
 * @param {number} [options.maxSize=100] - Largest page size accepted.
 * @returns {import('zod').ZodObject<any>} The pagination object schema (extend it with filters).
 */
const pageQuery = ({ firstPage = 1, sizeKey = 'perPage', defaultSize, maxSize = 100 } = {}) => {
  const page = z.coerce.number().int().min(firstPage);
  const size = z.coerce.number().int().min(1).max(maxSize);
  return z.object({
    page: defaultSize === undefined ? page.optional() : page.default(firstPage),
    [sizeKey]: defaultSize === undefined ? size.optional() : size.default(defaultSize),
  });
};

/**
 * @desc Zod superRefine for zxcvbn password strength
 */
const passwordRefinement = (val, ctx) => {
  if (config.zxcvbn.forbiddenPasswords.includes(val)) {
    ctx.addIssue({ code: 'custom', message: 'password is too common', input: val });
  } else if (zxcvbn(val).score < config.zxcvbn.minimumScore) {
    ctx.addIssue({ code: 'custom', message: `password must have a strength of at least ${config.zxcvbn.minimumScore}`, input: val });
  }
};

export { objectIdRegex, isObjectId, objectId, pageQuery };
export default { passwordRefinement, objectIdRegex, isObjectId, objectId, pageQuery };
