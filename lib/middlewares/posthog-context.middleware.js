/**
 * PostHog context middleware.
 *
 * Parses the `User-Agent` header to determine the request source and
 * attaches a `posthogContext` object to the request for downstream use
 * (e.g. enriching analytics events with CLI vs web attribution).
 *
 * Detection is config-driven: `config.analytics.cliUserAgentPattern` is a
 * regex-source string whose first capture group is the CLI version. When the
 * pattern is unset/empty, no CLI detection happens and the source stays 'web'.
 */

import config from '../../config/index.js';

/**
 * Build the CLI User-Agent matcher from config, or `null` when unconfigured.
 *
 * @returns {RegExp|null} compiled regex, or `null` if no/invalid pattern is set
 */
const getCliUaRe = () => {
  const pattern = config.analytics?.cliUserAgentPattern;
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
};

/**
 * Attach PostHog context to every request based on the User-Agent header.
 *
 * Sets `req.posthogContext` with:
 *   - `source`: `'cli'` when the configured CLI user-agent is detected, `'web'` otherwise
 *   - `cli_version`: CLI version string (only present when source is `'cli'`)
 *
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} _res - Express response (unused)
 * @param {import('express').NextFunction} next - Next middleware
 * @returns {void}
 */
export const posthogContextMiddleware = (req, _res, next) => {
  const ua = req.get('User-Agent') || '';
  const cliUaRe = getCliUaRe();
  const match = cliUaRe ? ua.match(cliUaRe) : null;
  req.posthogContext = match
    ? { source: 'cli', cli_version: match[1] }
    : { source: 'web' };
  next();
};
