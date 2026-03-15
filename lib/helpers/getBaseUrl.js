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
  if (Array.isArray(origin) && origin.length > 0) return origin[0];
  if (typeof origin === 'string') return origin;
  return '';
};

export default getBaseUrl;
