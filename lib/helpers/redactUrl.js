/**
 * Sensitive query-string parameters that must never reach the request log.
 *
 * `inviteToken` rides the query string of `POST /api/auth/signup?inviteToken=…`
 * (the Vue client puts it there, not in the body). The morgan log pattern logs
 * `:url`, so without redaction a live single-use invite token lands in prod logs
 * (and any log shipper / aggregator downstream). Redact it to `REDACTED`.
 */
const SENSITIVE_QUERY_KEYS = ['inviteToken'];

/**
 * Path segments that are immediately followed by a single-use secret carried as
 * a PATH parameter (not the query string). Routes such as
 * `GET /api/auth/reset/:token`, `POST /api/auth/verify-email/:token` and
 * `GET /api/*(auth/)?invitations/verify/:token` embed a still-valid token
 * directly in the path, so the segment right after one of these markers must be
 * redacted before the URL reaches any log/analytics store.
 */
const SENSITIVE_PATH_MARKERS = ['reset', 'verify', 'verify-email'];

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
 * @desc Redact sensitive query-string parameters from a request URL for logging.
 * Preserves the path and every other query parameter; only the value of a
 * sensitive key is replaced with `REDACTED`. Tolerant of a missing/empty URL and
 * URLs with no query string (returned unchanged). Pure + synchronous so it is
 * safe to call on every logged request.
 * @param {String} url - the raw request URL (path + optional query string)
 * @returns {String} the URL with sensitive query values redacted
 */
const redactUrl = (url) => {
  if (!url || typeof url !== 'string') return url;
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

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

  return `${pathPart}?${redactedQuery}`;
};

export default redactUrl;
export { SENSITIVE_QUERY_KEYS, SENSITIVE_PATH_MARKERS, redactPathSecrets };
