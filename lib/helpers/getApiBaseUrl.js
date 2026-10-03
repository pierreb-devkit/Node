/**
 * Module dependencies.
 */
import config from '../../config/index.js';

/**
 * @desc Resolve the API's own PUBLIC origin + base path (e.g. `https://api.acme.com/api`).
 * This is NOT `getBaseUrl()` (the frontend origin, `config.cors.origin`): a
 * link built from `getBaseUrl()` 404s on an API-only route (no SPA route
 * matches it) whenever the frontend and the API are served from different
 * hosts — which production deployments typically are.
 *
 * Primary source is `config.domain` — the stack's one documented public
 * domain (`lib/helpers/config.js`'s `validateDomainIsSet` warns when it's
 * empty; `lib/services/express.js#computeOpenApiServerUrl` is the other
 * reader). Mirrors that function's domain-to-origin rule exactly: a domain
 * that already carries a scheme is used verbatim; otherwise `https://api.`
 * is prepended (the api-subdomain convention for a split frontend/backend
 * topology, e.g. `acme.com` -> `https://api.acme.com`).
 *
 * `config.api.{protocol,host,port}` are used ONLY as a fallback, when
 * `config.domain` is empty — those three are the server's own BIND settings
 * (e.g. `0.0.0.0:3010` behind a reverse proxy), not necessarily its public
 * origin, so they are a last resort, never the primary source.
 *
 * Either way, `config.api.base` (the API's base path, `api` by default —
 * every route in this stack is mounted under the literal `/api` prefix) is
 * appended, so a caller builds a full link by appending only its own
 * resource path (e.g. `${getApiBaseUrl()}/users/unsubscribe/<token>`), the
 * same contract regardless of which branch resolved the origin.
 * @returns {string} The API's public origin + base path, no trailing slash.
 */
const getApiBaseUrl = () => {
  const { domain, api } = config;
  const origin = domain
    ? (/^https?:\/\//i.test(domain) ? domain : `https://api.${domain}`)
    : `${api.protocol}://${api.host}${api.port ? `:${api.port}` : ''}`;
  return `${origin.replace(/\/+$/, '')}/${api.base}`;
};

export default getApiBaseUrl;
