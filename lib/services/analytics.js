/**
 * Module dependencies
 */
import config from '../../config/index.js';

/**
 * PostHog client instance (null when not configured)
 * @type {import('posthog-node').PostHog|null}
 */
let client = null;

/**
 * Resolved at init time from config.analytics.posthog.appTag.
 * Stored here so capture() doesn't re-read config on every call.
 * @type {string|undefined}
 */
let _appTag;

/**
 * Initialise the PostHog client using application config.
 * When `analytics.posthog.enabled` is false OR `analytics.posthog.key` is absent the service
 * stays in no-op mode — every public method silently returns without
 * side-effects so that downstream projects that don't use PostHog are
 * never affected.
 *
 * The `posthog-node` SDK is lazy-loaded (dynamic import) so that
 * applications running on Node versions outside the SDK's engine
 * range never pay the import cost when analytics is unconfigured.
 * @returns {Promise<void>}
 */
const init = async () => {
  if (client) return; // already initialised — singleton guard
  const { enabled, key, host, flushAt, flushInterval, appTag } = config.analytics?.posthog ?? {};
  if (!enabled || !key) return;
  const { PostHog } = await import('posthog-node');
  const options = { host: host || 'https://eu.i.posthog.com' };
  if (flushAt != null) options.flushAt = flushAt;
  if (flushInterval != null) options.flushInterval = flushInterval;
  client = new PostHog(key, options);
  _appTag = appTag;
};

/**
 * Capture an analytics event.
 * @param {string} distinctId - User or anonymous identifier
 * @param {string} event - Event name
 * @param {Object} [properties] - Additional event properties
 * @param {Object} [groups] - Group identifiers (e.g. { company: orgId })
 * @returns {void}
 */
const track = (distinctId, event, properties, groups) => {
  if (!client) return;
  try {
    client.capture({ distinctId, event, properties, groups });
  } catch (_) { /* analytics must never break caller */ }
};

/**
 * Capture an analytics event with automatic context injection.
 * Auto-injects `app` (from config.analytics.posthog.appTag) and `env` (NODE_ENV)
 * into every event. Custom properties take precedence over defaults.
 * No-op when client is not initialised, distinctId or event are missing.
 *
 * Source attribution (highest wins):
 *   1. explicit `source` param
 *   2. `properties.source` (legacy/inline)
 *   3. `req.posthogContext.source` (set by posthogContextMiddleware)
 *   4. `'system'` default
 *
 * @param {Object} params - Event parameters
 * @param {string} params.distinctId - User or anonymous identifier
 * @param {string} params.event - Event name
 * @param {Object} [params.properties] - Additional event properties (win over defaults)
 * @param {import('express').Request} [params.req] - Optional Express request for context injection
 * @param {string} [params.source] - Explicit source override (wins over req + properties)
 * @returns {void}
 */
const capture = ({ distinctId, event, properties = {}, req, source } = {}) => {
  if (!client) return;
  if (!distinctId || !event) return;
  const defaults = {
    env: process.env.NODE_ENV || 'development',
    ...(_appTag ? { app: _appTag } : {}),
    source: 'system',
    ...(req?.posthogContext ?? {}),
  };
  const explicit = source ? { source } : {};
  try {
    client.capture({
      distinctId,
      event,
      properties: { ...defaults, ...properties, ...explicit },
    });
  } catch (_) { /* analytics must never break caller */ }
};

/**
 * Identify a user with optional properties.
 * @param {string} distinctId - User identifier
 * @param {Object} [properties] - User properties to set
 * @returns {void}
 */
const identify = (distinctId, properties) => {
  if (!client) return;
  try {
    client.identify({ distinctId, properties });
  } catch (_) { /* analytics must never break caller */ }
};

/**
 * Identify a group (e.g. organisation).
 * @param {string} groupType - Group type (e.g. "company")
 * @param {string} groupKey - Group identifier
 * @param {Object} [properties] - Group properties to set
 * @returns {void}
 */
const groupIdentify = (groupType, groupKey, properties) => {
  if (!client) return;
  try {
    client.groupIdentify({ groupType, groupKey, properties });
  } catch (_) { /* analytics must never break caller */ }
};

/**
 * Evaluate a feature flag for the given user.
 * @param {string} flag - Feature flag key
 * @param {string} distinctId - User identifier
 * @param {Object} [options] - Additional options forwarded to PostHog
 * @returns {Promise<string|boolean|undefined>} Flag value, or undefined when not configured
 */
const getFeatureFlag = async (flag, distinctId, options) => {
  if (!client) return undefined;
  return client.getFeatureFlag(flag, distinctId, options);
};

/**
 * Check whether a feature flag is enabled for the given user.
 * @param {string} flag - Feature flag key
 * @param {string} distinctId - User identifier
 * @param {Object} [options] - Additional options forwarded to PostHog
 * @returns {Promise<boolean|undefined>} true/false, or undefined when not configured
 */
const isFeatureEnabled = async (flag, distinctId, options) => {
  if (!client) return undefined;
  return client.isFeatureEnabled(flag, distinctId, options);
};

/**
 * Capture an exception event in PostHog.
 * Only active when `errorTracking` is opted-in via config — the caller
 * (`errorTracker.js`) is responsible for checking the flag before calling.
 * Safe to call when the PostHog client was never initialised.
 *
 * Uses SDK native `client.captureException()` so PostHog Error Tracking UI
 * groups events via auto-generated `$exception_list` + `$exception_fingerprint`.
 *
 * Source attribution (highest wins):
 *   1. explicit `ctx.source`
 *   2. `ctx.properties.source`
 *   3. `'system'` default
 *
 * @param {Error} err - Error to capture (no-op if null/undefined)
 * @param {Object} [ctx] - Optional context attached to the event
 * @param {string} [ctx.distinctId] - User identifier (default 'anonymous')
 * @param {string} [ctx.requestId] - Request trace ID
 * @param {string} [ctx.source] - Explicit source override
 * @param {Object} [ctx.properties] - Additional properties merged into the event
 * @returns {void}
 */
const captureException = (err, ctx = {}) => {
  if (!client) return;
  if (!err) return;
  try {
    const distinctId = ctx.distinctId || 'anonymous';
    const explicit = ctx.source ? { source: ctx.source } : {};
    const additionalProperties = {
      source: 'system',
      ...(ctx.properties ?? {}),
      ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}),
      ...explicit,
    };
    client.captureException(err, distinctId, additionalProperties);
  } catch (_) { /* analytics must never break caller */ }
};

/**
 * Resolve the PostHog distinctId for a request.
 *
 * Chain: `req.user?.id` → `req.sessionID` → `'anonymous'`.
 *
 * Returns `'anonymous'` when `req` is null/undefined so callers can use
 * the request-scoped helpers defensively without a pre-check. Callers
 * outside a request context (cron, worker, scheduled jobs) should keep
 * using {@link getFeatureFlag} / {@link isFeatureEnabled} with an
 * explicit identifier.
 * @param {import('express').Request|null|undefined} req - Express request
 * @returns {string} A stable distinct identifier
 */
const resolveDistinctId = (req) => {
  if (!req) return 'anonymous';
  // Use nullish checks so legitimate identifiers like `0` or empty strings
  // are preserved — any defined id is a valid PostHog distinctId.
  if (req.user?.id != null) return String(req.user.id);
  if (req.sessionID != null) return String(req.sessionID);
  return 'anonymous';
};

/**
 * Evaluate a feature flag using a distinctId extracted from the request.
 *
 * Sugar over {@link getFeatureFlag} that removes the boilerplate
 * `req.user?.id ?? req.sessionID ?? 'anonymous'` every route was
 * repeating — and guarantees the anonymous fallback is never forgotten.
 *
 * Use this in route handlers / middlewares. For callers without a
 * request (cron, worker, job), keep using {@link getFeatureFlag}.
 * @param {string} flag - Feature flag key
 * @param {import('express').Request|null|undefined} req - Express request
 * @param {Object} [options] - Additional options forwarded to PostHog
 * @returns {Promise<string|boolean|undefined>} Flag value, or undefined when not configured
 */
const getFeatureFlagForRequest = async (flag, req, options) =>
  getFeatureFlag(flag, resolveDistinctId(req), options);

/**
 * Request-aware variant of {@link isFeatureEnabled}.
 *
 * Same distinctId resolution as {@link getFeatureFlagForRequest}:
 * `req.user?.id` → `req.sessionID` → `'anonymous'`.
 * @param {string} flag - Feature flag key
 * @param {import('express').Request|null|undefined} req - Express request
 * @param {Object} [options] - Additional options forwarded to PostHog
 * @returns {Promise<boolean|undefined>} true/false, or undefined when not configured
 */
const isFeatureEnabledForRequest = async (flag, req, options) =>
  isFeatureEnabled(flag, resolveDistinctId(req), options);

/**
 * Return whether the PostHog client is currently initialised.
 * Use this as a cheap pre-check before building expensive analytics payloads.
 * The underlying `capture()` and `track()` methods are already no-ops when
 * the client is absent — `isConfigured()` is for callers that want to skip
 * payload construction entirely when analytics is not active.
 * @returns {boolean}
 */
const isConfigured = () => client !== null;

/**
 * Flush pending events and shut down the PostHog client.
 * Safe to call even when the client was never initialised.
 * @returns {Promise<void>}
 */
const shutdown = async () => {
  if (!client) return;
  await client.shutdown();
  client = null;
  _appTag = undefined;
};

export default {
  init,
  isConfigured,
  track,
  capture,
  identify,
  groupIdentify,
  getFeatureFlag,
  isFeatureEnabled,
  getFeatureFlagForRequest,
  isFeatureEnabledForRequest,
  captureException,
  shutdown,
};
