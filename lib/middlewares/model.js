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
 * check error and return if needed
 */
const checkError = (result) => {
  if (result && result.error) {
    if (result.error.original && (result.error.original.password || result.error.original.firstname))
      result.error.original = _.pick(result.error.original, config.whitelists.users.default);
    if (result.error._original && (result.error._original.password || result.error._original.firstname))
      result.error._original = _.pick(result.error._original, config.whitelists.users.default);
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
 * Check model is Valid with Zod schema
 */
const isValid = (schema) => (req, res, next) => {
  const method = req.method.toLowerCase();
  if (_.includes(config.validation.supportedMethods, method)) {
    const result = getResultFromZod(req.body, schema);
    const error = checkError(result);
    if (error) return responses.error(res, 422, 'Schema validation error', error)(result.error);
    req.body = result.value;
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
