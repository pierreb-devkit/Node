/**
 * Module dependencies.
 */
import config from '../../config/index.js';

/**
 * @desc Resolve the first CORS origin as the client-facing base URL.
 * Handles both array and string forms of config.cors.origin.
 * @returns {string} The base URL for building client-facing links.
 */
const getBaseUrl = () => {
  const origin = config.cors?.origin;
  const resolved = Array.isArray(origin) && origin.length > 0
    ? origin[0]
    : typeof origin === 'string'
      ? origin
      : '';
  return typeof resolved === 'string' ? resolved.replace(/\/+$/, '') : '';
};

export default getBaseUrl;
