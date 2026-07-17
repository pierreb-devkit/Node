/**
 * Module dependencies.
 */
import config from '../../config/index.js';

/**
 * Built-in, authoritative base lists. `lib/` must stay module-agnostic, so a
 * module/downstream project never edits this shared helper to add its own
 * token-bearing routes — it extends `config.log.sensitiveQueryKeys` /
 * `config.log.sensitivePathMarkers` (see below) instead. These built-ins
 * ALWAYS apply, unioned with whatever config contributes: config can only
 * ADD markers/keys, never remove or replace these, so redaction can never be
 * silently disabled (an absent key or an explicit empty array in config both
 * degrade to exactly these defaults, never to nothing).
 */
const DEFAULT_SENSITIVE_QUERY_KEYS = ['inviteToken', 'code', 'state'];
const DEFAULT_SENSITIVE_PATH_MARKERS = ['reset', 'verify', 'verify-email'];

/**
 * @desc Sanitize a config-provided redaction list so it is always an array
 * before it is spread into the union below. A config typo (an object, a
 * number, a bare string, …) must never throw at module-eval time — that
 * would crash the whole app on boot — and must never silently degrade into
 * a per-character array either (spreading a string splits it into individual
 * characters, which is not the extension list a config author intended and
 * would slip straight past an `Array.isArray`-less spread). Falls back to
 * an empty array, which is a no-op for the union below (identical to an
 * absent/missing key — the built-in defaults still apply), and logs a
 * warning identifying the offending config path so the typo gets noticed.
 * @param {*} value - the raw `config.log.<key>` value
 * @param {String} label - dotted config path for the warning message, e.g. 'log.sensitivePathMarkers'
 * @returns {Array} `value` unchanged when it is already an array, otherwise `[]`
 */
const sanitizeConfigList = (value, label) => {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  console.warn(`[redactUrl] config.${label} ignored: expected an array, got ${typeof value}`);
  return [];
};

/**
 * Sensitive query-string parameters that must never reach the request log.
 *
 * `inviteToken` rides the query string of `POST /api/auth/signup?inviteToken=…`
 * (the Vue client puts it there, not in the body). `code` and `state` ride the
 * query string of `GET /api/auth/:strategy/callback?code=…&state=…` (the OAuth
 * provider redirects there with the one-time authorization code). The morgan
 * log pattern logs `:url`, so without redaction a live single-use secret lands
 * in prod logs (and any log shipper / aggregator downstream). Redact them to
 * `REDACTED`.
 *
 * Union of `DEFAULT_SENSITIVE_QUERY_KEYS` and `config.log.sensitiveQueryKeys`:
 * a module/downstream project extends the set purely additively from its own
 * config, without editing this shared helper. Deduplicated via `Set`. Missing
 * config, a missing key, an explicit empty array, or a malformed (non-array)
 * value all resolve to exactly the built-in defaults — config can never
 * shrink or clobber this list.
 */
const SENSITIVE_QUERY_KEYS = [...new Set([...DEFAULT_SENSITIVE_QUERY_KEYS, ...sanitizeConfigList(config?.log?.sensitiveQueryKeys, 'log.sensitiveQueryKeys')])];

/**
 * Path segments that are immediately followed by a single-use secret carried as
 * a PATH parameter (not the query string). Routes such as
 * `GET /api/auth/reset/:token`, `POST /api/auth/verify-email/:token` and
 * `GET /api/*(auth/)?invitations/verify/:token` embed a still-valid token
 * directly in the path, so the segment right after one of these markers must be
 * redacted before the URL reaches any log/analytics store.
 *
 * Union of `DEFAULT_SENSITIVE_PATH_MARKERS` and `config.log.sensitivePathMarkers`:
 * a module/downstream project extends the set purely additively from its own
 * config, without editing this shared helper. Deduplicated via `Set`. Missing
 * config, a missing key, an explicit empty array, or a malformed (non-array)
 * value all resolve to exactly the built-in defaults — config can never
 * shrink or clobber this list.
 */
const SENSITIVE_PATH_MARKERS = [...new Set([...DEFAULT_SENSITIVE_PATH_MARKERS, ...sanitizeConfigList(config?.log?.sensitivePathMarkers, 'log.sensitivePathMarkers')])];

/**
 * @desc Redact single-use secrets embedded as PATH parameters. Any segment that
 * immediately follows a sensitive marker (see `SENSITIVE_PATH_MARKERS`) is
 * replaced with `REDACTED`; every other segment is preserved. Operates on the
 * path portion only — callers strip the query string first. Pure + synchronous,
 * tolerant of a missing/empty value (returned unchanged).
 * @param {String} path - the request path (no query string)
 * @returns {String} the path with secret segments redacted
 */
const redactPathSecrets = (path) => {
  if (!path || typeof path !== 'string') return path;

  const segments = path.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (SENSITIVE_PATH_MARKERS.includes(segments[i]) && segments[i + 1]) {
      segments[i + 1] = 'REDACTED';
    }
  }
  return segments.join('/');
};

/**
 * @desc Redact single-use secrets from a request URL for logging: sensitive
 * PATH segments (see `redactPathSecrets`) AND sensitive query-string
 * parameters. Preserves every other path segment and query parameter; only
 * matching path segments / query values are replaced with `REDACTED`.
 * Tolerant of a missing/empty URL and URLs with no query string. Pure +
 * synchronous so it is safe to call on every logged request.
 * @param {String} url - the raw request URL (path + optional query string)
 * @returns {String} the URL with sensitive path segments and query values redacted
 */
const redactUrl = (url) => {
  if (!url || typeof url !== 'string') return url;
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return redactPathSecrets(url);

  const pathPart = url.slice(0, queryStart);
  const queryPart = url.slice(queryStart + 1);

  const redactedQuery = queryPart
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      if (SENSITIVE_QUERY_KEYS.includes(key)) return `${key}=REDACTED`;
      return pair;
    })
    .join('&');

  return `${redactPathSecrets(pathPart)}?${redactedQuery}`;
};

export default redactUrl;
export { SENSITIVE_QUERY_KEYS, SENSITIVE_PATH_MARKERS, redactPathSecrets };
