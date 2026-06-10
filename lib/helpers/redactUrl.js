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
export { SENSITIVE_QUERY_KEYS };
