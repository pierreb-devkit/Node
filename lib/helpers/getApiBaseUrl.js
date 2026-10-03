/**
 * Module dependencies.
 */
import config from '../../config/index.js';

/**
 * @desc Resolve the API's own origin + base path (`config.api.{protocol,host,port,base}`),
 * e.g. `http://127.0.0.1:3000/api`. This is NOT `getBaseUrl()` (the frontend
 * origin, `config.cors.origin`): a link built from `getBaseUrl()` 404s on an API-only
 * route (no SPA route matches it) whenever the frontend and the API are served
 * from different hosts — which production deployments typically are. Use this
 * helper for any link that points at an API route directly (the one-click
 * unsubscribe POST, an OAuth callback URL) instead of a frontend page.
 *
 * Same string this stack's OAuth strategies (`modules/auth/strategies/local/{google,apple}.js`)
 * already built inline for their own `callbackURL` — extracted here so every
 * API-origin link site shares one implementation instead of three copies that
 * can drift. Behavior-identical: `config.api.port` is only appended (with its
 * leading `:`) when truthy, same as the inline expression it replaces.
 * @returns {string} The API origin + base path, no trailing slash.
 */
const getApiBaseUrl = () => `${config.api.protocol}://${config.api.host}${config.api.port ? `:${config.api.port}` : ''}/${config.api.base}`;

export default getApiBaseUrl;
