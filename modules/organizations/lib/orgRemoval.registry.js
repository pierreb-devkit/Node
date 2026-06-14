/**
 * @module organizations/lib/orgRemoval.registry
 * @description Subscriber registry for organization-removal cleanup.
 *   Optional modules register a handler at load time via `onOrganizationRemoved`;
 *   the organization crud service runs them sequentially on org delete and
 *   propagates their errors (no silent swallow). Config-free, import-safe leaf —
 *   it must not import organization/tasks services (avoids an import cycle).
 */

const handlers = [];

/**
 * @function onOrganizationRemoved
 * @description Register a cleanup handler fired when an organization is removed.
 * @param {Function} fn - async (payload) => void; payload is { organizationId, organization }.
 * @returns {void}
 */
export const onOrganizationRemoved = (fn) => {
  if (typeof fn !== 'function') throw new TypeError('onOrganizationRemoved: fn must be a function');
  handlers.push(fn);
};

/**
 * @function runOrganizationRemovedHandlers
 * @description Run every registered handler sequentially. Errors propagate (not swallowed).
 * @param {Object} payload - { organizationId, organization }.
 * @returns {Promise<void>}
 */
export const runOrganizationRemovedHandlers = async (payload) => {
  for (const fn of handlers) {
    await fn(payload); // sequential: each handler must resolve before the next runs
  }
};

/**
 * @function _reset
 * @description Test helper — clears all registered handlers.
 * @returns {void}
 */
export const _reset = () => {
  handlers.length = 0;
};

export default { onOrganizationRemoved, runOrganizationRemovedHandlers, _reset };
