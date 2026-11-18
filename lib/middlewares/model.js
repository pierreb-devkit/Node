/**
 * Module dependencies
 */
import _ from 'lodash';
import config from '../../config/index.js';
import responses from '../helpers/responses.js';

const cleanError = (string) =>
  string
    .replace(/conditions\[(.*?)\]/g, '')
    .replace(/checks\[(.*?)\]/g, '')
    .replace(/"/g, ' ')
    .replace(/\./g, ' ')
    .replace(/ {2}/g, ' ')
    .trim();

/**
 * get Zod result
 */
const getResultFromZod = (body, schema) => {
  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      error: {
        original: body,
        _original: body,
        details: result.error.issues.map(({ message, code }) => ({
          message: message.replace(/['"]/g, ''),
          type: code,
        })),
      },
    };
  }
  return { value: result.data };
};

/**
 * Body keys that carry a secret and must never be echoed back in a 422 error payload.
 */
const SECRET_KEYS = ['password', 'newPassword', 'currentPassword', 'verifyPassword', 'token'];

/**
 * Strip user data and secrets from a rejected body before it is attached to the error.
 * @param {*} body - The original request body.
 * @returns {*} The body without user fields outside the default whitelist and without secrets.
 */
const scrubBody = (body) => {
  if (!body || typeof body !== 'object') return body;
  const picked = body.password || body.firstName ? _.pick(body, config.whitelists.users.default) : body;
  return _.omit(picked, SECRET_KEYS);
};

/**
 * check error and return if needed
 */
const checkError = (result) => {
  if (result && result.error) {
    result.error.original = scrubBody(result.error.original);
    result.error._original = scrubBody(result.error._original);
    let description = '';
    result.error.details.forEach((err) => {
      const message = cleanError(err.message);
      description += `${message.charAt(0).toUpperCase() + message.slice(1).toLowerCase()}. `;
    });
    return description;
  }
  return false;
};

/**
 * Check model is Valid with Zod schema.
 * For PUT and PATCH requests, only original keys are preserved to prevent Zod
 * defaults from overwriting existing data on partial updates. For POST, the full
 * parsed output (including defaults) is used.
 * @param {import('zod').ZodSchema} schema - Zod schema to validate request body against.
 * @returns {Function} Express middleware function that validates req.body.
 */
const isValid = (schema) => (req, res, next) => {
  const method = req.method.toLowerCase();
  if (_.includes(config.validation.supportedMethods, method)) {
    const result = getResultFromZod(req.body, schema);
    const error = checkError(result);
    if (error) return responses.error(res, 422, 'Schema validation error', error)(result.error);
    // For updates (PUT, PATCH), preserve only original keys to prevent Zod defaults
    // from overwriting existing data. For creates (POST), use full output with defaults.
    if (method === 'put' || method === 'patch') {
      const originalKeys = Object.keys(req.body).filter((k) => Object.prototype.hasOwnProperty.call(result.value, k));
      req.body = Object.fromEntries(originalKeys.map((k) => [k, result.value[k]]));
    } else {
      req.body = result.value;
    }
    return next();
  }
  next();
};

export default {
  cleanError,
  getResultFromZod,
  checkError,
  isValid,
};
