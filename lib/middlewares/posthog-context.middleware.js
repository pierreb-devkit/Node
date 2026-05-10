/**
 * PostHog context middleware.
 *
 * Parses the `User-Agent` header to determine the request source and
 * attaches a `posthogContext` object to the request for downstream use
 * (e.g. enriching analytics events with CLI vs web attribution).
 *
 * Detection: `@trawlme/cli/<version>` in UA → source: 'cli', cli_version: '<version>'
 * Everything else (browser, curl, unknown) → source: 'web'
 */

const CLI_UA_RE = /@trawlme\/cli\/(\S+)/;

/**
 * Attach PostHog context to every request based on the User-Agent header.
 *
 * Sets `req.posthogContext` with:
 *   - `source`: `'cli'` when `@trawlme/cli/<version>` is detected, `'web'` otherwise
 *   - `cli_version`: CLI version string (only present when source is `'cli'`)
 *
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} _res - Express response (unused)
 * @param {import('express').NextFunction} next - Next middleware
 * @returns {void}
 */
export const posthogContextMiddleware = (req, _res, next) => {
  const ua = req.get('User-Agent') || '';
  const match = ua.match(CLI_UA_RE);
  req.posthogContext = match
    ? { source: 'cli', cli_version: match[1] }
    : { source: 'web' };
  next();
};
