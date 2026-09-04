import config from '../../config/index.js';
import configHelper from './config.js';

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
 * Production-safe subset of `AppError.details` keys. Opt-in ONLY — a
 * whitelist, never a denylist — so a key nobody thought to hide stays hidden
 * by default instead of leaking by default. Matched by EXACT key name only
 * (no prefix/suffix rule like "anything ending in Url"), so a future key such
 * as an internal-only URL can never slip through by naming convention.
 * @readonly
 */
const DEFAULT_DETAILS_WHITELIST = ['upgradeUrl', 'type', 'retryAfter'];

/**
 * @desc Sanitize a config-provided whitelist extension so a typo or wrong
 * type can never crash boot or silently degrade into something unsafe.
 * Mirrors `redactUrl.js#sanitizeConfigList` — same union-only contract.
 * @param {*} value - the raw `config.errors.detailsWhitelist` value
 * @param {String} label - dotted config path for the warning message
 * @return {Array} `value` unchanged when it is already an array, otherwise `[]`
 */
const sanitizeConfigList = (value, label) => {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  console.warn(`[responses] config.${label} ignored: expected an array, got ${typeof value}`);
  return [];
};

/**
 * Union of `DEFAULT_DETAILS_WHITELIST` and `config.errors.detailsWhitelist`: a
 * downstream project ADDS its own production-safe detail keys from its own
 * config, without patching this stack file. Deduplicated via `Set`. Missing
 * config, a missing key, an explicit empty array, or a malformed (non-array)
 * value all resolve to exactly the built-in defaults — config can only ever
 * grow this set with keys the downstream project itself opts in, never turn
 * it into a denylist and never remove a built-in entry.
 */
const DETAILS_WHITELIST = new Set([
  ...DEFAULT_DETAILS_WHITELIST,
  ...sanitizeConfigList(config?.errors?.detailsWhitelist, 'errors.detailsWhitelist'),
]);

/**
 * @desc Pick the production-safe subset of `AppError.details` by EXACT key
 * match against `DETAILS_WHITELIST`. Applies in every environment — there is
 * nothing dev-only about it, it is a strict subset of what dev-grade envs
 * already get via the full serialized-error blob below. Anything that is not
 * a plain object (a bare string, the `[{ message }]` array AppError defaults
 * to, `undefined`) has no own keys to match and yields no result, so the
 * common case (no whitelisted key present) adds nothing to the envelope.
 * @param {*} details - `AppError.details`, in whatever shape the throw site built it
 * @return {Object|undefined} whitelisted key/value pairs, or `undefined` when none matched
 */
const pickWhitelistedDetails = (details) => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const picked = {};
  for (const key of DETAILS_WHITELIST) {
    if (Object.prototype.hasOwnProperty.call(details, key)) picked[key] = details[key];
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
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
  if (Array.isArray(err?.details)) {
    const messages = err.details
      .map((item) => {
        if (!item) return null;
        if (typeof item === 'string') return item;
        if (typeof item.message === 'string') return item.message;
        return null;
      })
      .filter(Boolean);
    if (messages.length > 0) return messages.join(', ');
  }
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
 * @param {number} httpStatus - HTTP status code or candidate error status
 * @param {string} message - Error message to send to the client
 * @param {string} description - Optional detailed error description
 * @return {Object} type, message, code, status, errorCode, description and (when
 *   any whitelisted key was present) details
 */
const error = (res, httpStatus, message, description) => (error = {}) => {
  const status = getHttpStatus(httpStatus, error);
  const whitelistedDetails = pickWhitelistedDetails(error.details);
  const result = {
    type: 'error',
    message: message || error.message || 'Something went wrong.',
    code: status,
    status,
    errorCode: getErrorCode(error),
    description: getDescription(description, error),
    // Whitelisted details (e.g. billing's upgradeUrl/type) cross into every
    // environment, production included — see DETAILS_WHITELIST above. Only
    // added when at least one key matched, so most error responses are
    // unaffected.
    ...(whitelistedDetails ? { details: whitelistedDetails } : {}),
  };
  // Only expose the serialized raw error in dev-grade envs (development/test/local).
  // Any other NODE_ENV (production or a deployment env label) gets the generic
  // envelope only — prevents internal detail leaks under the downstream run model.
  if (!configHelper.isProd()) result.error = safeStringify(error);
  res.status(status).json(result);
  return result;
};

export default {
  success,
  error,
};
