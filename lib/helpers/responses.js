import config from '../../config/index.js';
import configHelper from './config.js';
import UNSAFE_KEYS from './unsafeKeys.js';

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
 * type can never crash boot or silently degrade into something unsafe. Two
 * layers of validation: (1) whole-value shape — a non-array value (typo,
 * wrong type) degrades to `[]`, a no-op for the union below, same contract as
 * `redactUrl.js#sanitizeConfigList`; (2) per-element — each surviving element
 * must be a non-empty string AND may not be one of `UNSAFE_KEYS`
 * (`__proto__`/`constructor`/`prototype`, from `./unsafeKeys.js` — the SAME
 * Set `config/index.js#deepMerge` guards its own merge with, so the two
 * guards cannot drift apart. Extracted to its own tiny module rather than
 * imported from `config/index.js` directly: that module is mocked down to
 * `{ default: {...} }`, no named exports, across ~100 test files, so a
 * required named import from it would break every one of those mocks —
 * demonstrated, not theoretical). The per-element layer is additional
 * versus `redactUrl.js`'s copy: that list is only ever used with
 * `.includes()`, this one's entries become object property keys in
 * `pickWhitelistedDetails` below, where an unguarded `__proto__` could
 * reassign a prototype. A non-string, empty-string, or unsafe element is
 * dropped silently, never included and never crashes boot.
 * @param {*} value - the raw `config.errors.detailsWhitelist` value
 * @param {String} label - dotted config path for the warning message
 * @return {Array} the sanitized, per-element-safe list; `[]` for a malformed whole value
 */
const sanitizeConfigList = (value, label) => {
  if (Array.isArray(value)) {
    return value.filter((key) => typeof key === 'string' && key.length > 0 && !UNSAFE_KEYS.has(key));
  }
  if (value == null) return [];
  console.warn(`[responses] config.${label} ignored: expected an array, got ${typeof value}`);
  return [];
};

/**
 * @desc Pure builder for the effective whitelist: sanitize `configValue` (see
 * `sanitizeConfigList`) and union it with `DEFAULT_DETAILS_WHITELIST`.
 * Extracted as a pure function (config value in, `Set` out) rather than only
 * existing as the module-load-time `DETAILS_WHITELIST` singleton below, so
 * config-widening — including the `UNSAFE_KEYS` rejection and per-element
 * filtering — is directly unit-testable without `jest.resetModules()`
 * gymnastics.
 * @param {*} configValue - the raw `config.errors.detailsWhitelist` value
 * @return {Set<String>} the built-in defaults unioned with the sanitized config extension
 */
const buildWhitelist = (configValue) => new Set([...DEFAULT_DETAILS_WHITELIST, ...sanitizeConfigList(configValue, 'errors.detailsWhitelist')]);

/**
 * Union of `DEFAULT_DETAILS_WHITELIST` and `config.errors.detailsWhitelist`
 * (via `buildWhitelist` above): a downstream project ADDS its own
 * production-safe detail keys from its own config, without patching this
 * stack file. Deduplicated via `Set`. Missing config, a missing key, an
 * explicit empty array, or a malformed (non-array) value all resolve to
 * exactly the built-in defaults. Per element, `sanitizeConfigList` also drops
 * anything that is not a non-empty string and anything in `UNSAFE_KEYS`
 * (`__proto__`/`constructor`/`prototype`) — config can only ever grow this
 * set with safe, downstream-chosen keys, never turn it into a denylist,
 * never remove a built-in entry, and never smuggle in a prototype-polluting
 * key.
 */
const DETAILS_WHITELIST = buildWhitelist(config?.errors?.detailsWhitelist);

/**
 * Whitelisted-detail values must be safe, boring scalars — a whitelisted KEY
 * only gates which properties are looked at; without a value check too, a
 * caller that hands the picker a raw exception (`details: err` / `details:
 * err.details || err` — several call sites across the stack do exactly this)
 * could leak an entire nested object simply by that exception owning a
 * property that happens to be named `type`, `upgradeUrl` or `retryAfter`.
 * Safe = `null`, a `boolean`, a finite `number`, or a `string` no longer than
 * `MAX_DETAIL_VALUE_LENGTH`. Everything else (object, array, function,
 * `undefined`, `NaN`/`Infinity`, an over-length string) is dropped, never
 * coerced or stringified — fail closed.
 * @readonly
 */
const MAX_DETAIL_VALUE_LENGTH = 200; // generous for a real upgradeUrl path or a short enum-style
// type/retryAfter value, but bounded so a raw exception's arbitrarily long
// string property (e.g. a stack-trace-shaped `.type`) can't inject an
// oversized blob into the production response body.

/**
 * @desc Decide whether a single whitelisted-key value is safe to serialize
 * into the production error envelope. See `MAX_DETAIL_VALUE_LENGTH` doc above
 * for the exact safe shape and the reasoning behind it.
 * @param {*} value - the value found at a whitelisted key
 * @return {boolean} true when `value` is a safe scalar
 */
const isSafeDetailValue = (value) => {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_DETAIL_VALUE_LENGTH;
  return false;
};

/**
 * @desc Pick the production-safe subset of `AppError.details` by EXACT key
 * match against `whitelist`, keeping ONLY values that pass
 * `isSafeDetailValue` — a matched key whose value is an object, array,
 * function, `undefined` or non-finite number is dropped, not passed through
 * (see `isSafeDetailValue` doc for why the key match alone is not enough).
 * Applies in every environment — there is nothing dev-only about it, it is a
 * strict subset of what dev-grade envs already get via the full
 * serialized-error blob below. Anything that is not a plain object (a bare
 * string, the `[{ message }]` array AppError defaults to, `undefined`) has no
 * own keys to match and yields no result, so the common case (no whitelisted
 * key present) adds nothing to the envelope. Builds the result with
 * `Object.create(null)` — belt and braces alongside the `UNSAFE_KEYS` config
 * guard above — so even a details object carrying a real own `__proto__`
 * property can only ever become an own data property on the picked object,
 * never reassign its prototype ahead of `JSON.stringify`.
 * @param {*} details - `AppError.details`, in whatever shape the throw site built it
 * @param {Set<String>} [whitelist] - keys to match; defaults to the module's `DETAILS_WHITELIST`
 * @return {Object|undefined} whitelisted key/value pairs (a null-prototype object), or `undefined` when none matched
 */
const pickWhitelistedDetails = (details, whitelist = DETAILS_WHITELIST) => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const picked = Object.create(null);
  for (const key of whitelist) {
    if (!Object.prototype.hasOwnProperty.call(details, key)) continue;
    // A whitelisted key may be backed by a throwing getter (e.g. `details`
    // built from a raw caught exception whose accessor reads a closed
    // resource). Reading it must never propagate out of the picker — that
    // would abort the whole response instead of just dropping this one key
    // — and must never stop the loop from picking the remaining whitelisted
    // keys. Fail closed and stay silent-safe: same "drop this key" contract
    // as every other unsafe shape handled by `isSafeDetailValue`.
    try {
      const value = details[key];
      if (isSafeDetailValue(value)) picked[key] = value;
    } catch (_err) {
      // Drop this key only; continue with the rest of the whitelist.
    }
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

// Pure helpers exported for direct unit testing — see `pickWhitelistedDetails`
// and `buildWhitelist` doc comments above for why (belt-and-braces
// null-prototype defense, and config-widening without `jest.resetModules()`).
// `isSafeDetailValue` is intentionally NOT exported: nothing calls it
// directly, its branches are already exercised indirectly through
// `pickWhitelistedDetails`/`responses.error` (see the "whitelisted details
// value validation" describe block), and this stack keeps a module's public
// surface limited to what something outside it actually needs.
export { buildWhitelist, pickWhitelistedDetails };
