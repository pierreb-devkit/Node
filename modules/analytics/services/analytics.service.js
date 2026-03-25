/**
 * Module dependencies
 */
import config from '../../../config/index.js';

/**
 * PostHog client instance (null when not configured)
 * @type {import('posthog-node').PostHog|null}
 */
let client = null;

/**
 * Initialise the PostHog client using application config.
 * When `posthog.apiKey` is absent the service stays in no-op mode —
 * every public method silently returns without side-effects so that
 * downstream projects that don't use PostHog are never affected.
 *
 * The `posthog-node` SDK is lazy-loaded (dynamic import) so that
 * applications running on Node versions outside the SDK's engine
 * range never pay the import cost when analytics is unconfigured.
 * @returns {Promise<void>}
 */
const init = async () => {
  const { apiKey, host } = config.posthog ?? {};
  if (!apiKey) return;
  const { PostHog } = await import('posthog-node');
  client = new PostHog(apiKey, { host: host || 'https://us.i.posthog.com' });
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
  client.capture({ distinctId, event, properties, groups });
};

/**
 * Identify a user with optional properties.
 * @param {string} distinctId - User identifier
 * @param {Object} [properties] - User properties to set
 * @returns {void}
 */
const identify = (distinctId, properties) => {
  if (!client) return;
  client.identify({ distinctId, properties });
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
  client.groupIdentify({ groupType, groupKey, properties });
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
 * Flush pending events and shut down the PostHog client.
 * Safe to call even when the client was never initialised.
 * @returns {Promise<void>}
 */
const shutdown = async () => {
  if (!client) return;
  await client.shutdown();
  client = null;
};

export default {
  init,
  track,
  identify,
  groupIdentify,
  getFeatureFlag,
  isFeatureEnabled,
  shutdown,
};
