/**
 * @module users/lib/dataProvider.registry
 * @description Config-free, import-safe leaf registry that optional modules
 *   use to self-register a GDPR data provider. Mirrors the pattern from
 *   organizations/lib/orgRemoval.registry.js but uses a Map keyed by a stable
 *   string key (not a Set of fn identities) so an inline-arrow registration
 *   in a *.init.js can't double-register.
 */

const providers = new Map();

/**
 * @function registerDataProvider
 * @description Register a GDPR data provider for a module.
 * @param {Object} options
 * @param {string} options.key - Stable unique identifier for this provider (e.g. 'tasks', 'uploads').
 * @param {'user'|'org'} options.axis - Whether this provider handles user-scoped or org-scoped data.
 * @param {'delete'|'anonymize'} options.retention - Whether to hard-delete or anonymize data on erasure.
 * @param {Function} [options.export] - async (payload) => Object — exports user/org data.
 * @param {Function} [options.erase] - async (payload) => Object — erases/anonymizes user/org data.
 * @returns {void}
 */
export const registerDataProvider = ({ key, axis, retention, export: exportFn, erase }) => {
  if (typeof key !== 'string' || !key) {
    throw new TypeError('registerDataProvider: key must be a non-empty string');
  }
  if (axis !== 'user' && axis !== 'org') {
    throw new TypeError('registerDataProvider: axis must be "user" or "org"');
  }
  if (retention !== 'delete' && retention !== 'anonymize') {
    throw new TypeError('registerDataProvider: retention must be "delete" or "anonymize"');
  }
  if (typeof exportFn !== 'function') {
    throw new TypeError('registerDataProvider: export must be a function');
  }
  if (typeof erase !== 'function') {
    throw new TypeError('registerDataProvider: erase must be a function');
  }

  providers.set(key, { key, axis, retention, export: exportFn, erase });
};

/**
 * @function runDataExport
 * @description Run all registered providers' export functions sequentially.
 * @param {Object} payload - { userId?, organizationIds? } depending on axis.
 * @returns {Promise<{ data: Object, modules: string[] }>}
 */
export const runDataExport = async (payload) => {
  const data = {};
  const modules = [];

  for (const [key, provider] of providers) {
    const result = await provider.export(payload);
    data[key] = result;
    modules.push(key);
  }

  return { data, modules };
};

/**
 * @function runDataErasure
 * @description Run all registered providers' erase functions sequentially.
 *   Errors propagate (fail-closed) — if one provider fails, subsequent ones
 *   are not executed.
 * @param {Object} payload - { userId?, organizationIds? } depending on axis.
 * @returns {Promise<{ results: Object }>}
 */
export const runDataErasure = async (payload) => {
  const results = {};

  for (const [key, provider] of providers) {
    const result = await provider.erase(payload);
    results[key] = result;
  }

  return { results };
};

/**
 * @function getProviders
 * @description Get all registered providers (read-only view for testing/inspection).
 * @returns {Map<string, Object>}
 */
export const getProviders = () => new Map(providers);

/**
 * @function _reset
 * @description Test helper — clears all registered providers.
 * @returns {void}
 */
export const _reset = () => {
  providers.clear();
};

export default {
  registerDataProvider,
  runDataExport,
  runDataErasure,
  getProviders,
  _reset,
};
