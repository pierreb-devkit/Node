/**
 * @desc Function res success
 * @param {Object} res - Express response object
 * @param {String} success message
 * @return {Object} type, message and data
 */
const success = (res, message) => (data) => {
  const result = { type: 'success', message, data };
  res.status(200).json(result);
  return result;
};

/**
 * @desc Validate HTTP status code boundaries
 * @param {number} status - Candidate HTTP status code
 * @return {boolean} true when status is a valid HTTP code
 */
const isValidHttpStatus = (status) => Number.isInteger(status) && status >= 100 && status <= 599;

/**
 * @desc Resolve HTTP status code from explicit value or error object fallback
 * @param {number} status - Explicit status code
 * @param {Object} err - Error object potentially containing status values
 * @return {number} normalized HTTP status code
 */
const getHttpStatus = (status, err) => {
  if (isValidHttpStatus(status)) return status;
  if (isValidHttpStatus(err?.status)) return err.status;
  if (isValidHttpStatus(err?.statusCode)) return err.statusCode;
  if (isValidHttpStatus(err?.code)) return err.code;
  return 500;
};

/**
 * @desc Resolve safe client description text for error payload
 * @param {string} description - Explicit description override
 * @param {Object} err - Error object
 * @return {string} error description
 */
const getDescription = (description, err) => {
  if (description) return description;
  if (err?.description) return err.description;
  if (typeof err?.details === 'string') return err.details;
  if (err?.details?.message) return err.details.message;
  return '';
};

/**
 * @desc Resolve stable domain error code from an error object
 * @param {Object} err - Error object
 * @return {string} domain error code
 */
const getErrorCode = (err) => {
  if (typeof err?.code === 'string' && err.code) return err.code;
  return 'SERVER_ERROR';
};

/**
 * @desc JSON stringify helper resilient to circular payloads
 * @param {Object} value - Value to stringify
 * @return {string} safe JSON string
 */
const safeStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return JSON.stringify({ message: 'Unserializable error object' });
  }
};

/**
 * @desc Function res error
 * @param {Object} res - Express response object
 * @param {String} success message
 * @return {Object} type, message and error
 */
const error = (res, code, message, description) => (error = {}) => {
  const status = getHttpStatus(code, error);
  const result = {
    type: 'error',
    message: message || error.message || 'Something went wrong.',
    code: status,
    status,
    errorCode: getErrorCode(error),
    description: getDescription(description, error),
  };
  if (process.env.NODE_ENV !== 'production') result.error = safeStringify(error);
  res.status(status).json(result);
  return result;
};

export default {
  success,
  error,
};
