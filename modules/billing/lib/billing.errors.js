/**
 * @function isDuplicateKeyError
 * @description Identify Mongo duplicate-key errors across driver and string-only shapes.
 * @param {Error|Object} err - Error object to inspect.
 * @returns {boolean} True when the error represents E11000 duplicate key.
 */
export const isDuplicateKeyError = (err) =>
  err?.code === 11000 || (typeof err?.message === 'string' && err.message.includes('E11000'));

export default {
  isDuplicateKeyError,
};
