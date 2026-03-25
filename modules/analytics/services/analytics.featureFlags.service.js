/**
 * Module dependencies
 */
import AnalyticsService from './analytics.service.js';

/**
 * Check whether a feature flag is enabled for a given user.
 * Builds the PostHog options object from the provided context so callers
 * don't need to know the PostHog SDK shape.
 *
 * Returns `false` when analytics is not configured (safe default) so that
 * downstream projects without PostHog are never blocked.
 *
 * @param {string} flag - Feature flag key
 * @param {string} distinctId - User identifier
 * @param {Object} [options] - Evaluation context
 * @param {Object} [options.personProperties] - Properties for local evaluation
 * @param {Object} [options.groups] - Group identifiers (e.g. { company: orgId })
 * @param {Object} [options.groupProperties] - Properties per group type
 * @returns {Promise<boolean>} true when the flag is enabled, false otherwise
 */
const isEnabled = async (flag, distinctId, options = {}) => {
  const { personProperties, groups, groupProperties } = options;
  const phOptions = {};
  if (personProperties) phOptions.personProperties = personProperties;
  if (groups) phOptions.groups = groups;
  if (groupProperties) phOptions.groupProperties = groupProperties;

  const result = await AnalyticsService.isFeatureEnabled(flag, distinctId, phOptions);
  // Normalise undefined (not configured) to false for a safe default
  return result === true;
};

/**
 * Get the variant value of a feature flag for a given user.
 * Returns the variant key string, a boolean, or `undefined` when analytics
 * is not configured.
 *
 * @param {string} flag - Feature flag key
 * @param {string} distinctId - User identifier
 * @param {Object} [options] - Evaluation context
 * @param {Object} [options.personProperties] - Properties for local evaluation
 * @param {Object} [options.groups] - Group identifiers (e.g. { company: orgId })
 * @param {Object} [options.groupProperties] - Properties per group type
 * @returns {Promise<string|boolean|undefined>} Variant value
 */
const getVariant = async (flag, distinctId, options = {}) => {
  const { personProperties, groups, groupProperties } = options;
  const phOptions = {};
  if (personProperties) phOptions.personProperties = personProperties;
  if (groups) phOptions.groups = groups;
  if (groupProperties) phOptions.groupProperties = groupProperties;

  return AnalyticsService.getFeatureFlag(flag, distinctId, phOptions);
};

export default {
  isEnabled,
  getVariant,
};
