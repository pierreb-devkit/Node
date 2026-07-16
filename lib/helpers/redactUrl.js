/**
 * Module dependencies.
 */
import config from '../../config/index.js';

/**
 * Built-in fallback values. `lib/` must stay module-agnostic — the real source
 * of truth is `config.log.sensitiveQueryKeys` / `config.log.sensitivePathMarkers`
 * (see below), which a module extends from its own config without editing this
 * shared helper. These literals are the ultimate fallback: if config is absent
 * or does not define the key (e.g. an edge context that builds a partial config
 * object), redaction still degrades safely to the current known-sensitive
 * routes instead of silently redacting nothing.
 */
const DEFAULT_SENSITIVE_QUERY_KEYS = ['inviteToken'];
const DEFAULT_SENSITIVE_PATH_MARKERS = ['reset', 'verify', 'verify-email'];

/**
 * Sensitive query-string parameters that must never reach the request log.
 *
 * `inviteToken` rides the query string of `POST /api/auth/signup?inviteToken=…`
 * (the Vue client puts it there, not in the body). The morgan log pattern logs
 * `:url`, so without redaction a live single-use invite token lands in prod logs
 * (and any log shipper / aggregator downstream). Redact it to `REDACTED`.
 *
 * Sourced from `config.log.sensitiveQueryKeys` (extendable per-module without
 * editing this shared helper); falls back to `DEFAULT_SENSITIVE_QUERY_KEYS`
 * when config/the key is absent so redaction never silently degrades to nothing.
 */
const SENSITIVE_QUERY_KEYS = config?.log?.sensitiveQueryKeys ?? DEFAULT_SENSITIVE_QUERY_KEYS;

/**
 * Path segments that are immediately followed by a single-use secret carried as
 * a PATH parameter (not the query string). Routes such as
 * `GET /api/auth/reset/:token`, `POST /api/auth/verify-email/:token` and
 * `GET /api/*(auth/)?invitations/verify/:token` embed a still-valid token
 * directly in the path, so the segment right after one of these markers must be
 * redacted before the URL reaches any log/analytics store.
 *
 * Sourced from `config.log.sensitivePathMarkers` (extendable per-module without
 * editing this shared helper); falls back to `DEFAULT_SENSITIVE_PATH_MARKERS`
 * when config/the key is absent so redaction never silently degrades to nothing.
 */
const SENSITIVE_PATH_MARKERS = config?.log?.sensitivePathMarkers ?? DEFAULT_SENSITIVE_PATH_MARKERS;

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
