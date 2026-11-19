/**
 * @module organizations/lib/orgRemoval.registry
 * @description Subscriber registry for organization-removal cleanup.
 *   Optional modules register a handler at load time via `onOrganizationRemoved`;
 *   `runOrganizationRemovedHandlers` runs every handler sequentially, ISOLATING each —
 *   one handler throwing never prevents the remaining handlers from running (so a bug
 *   in one module's cleanup can't orphan another module's org-scoped rows). Failures are
 *   collected and, after the full run, re-raised together as a single AggregateError to
 *   ITS caller (no silent swallow inside this module). The current sole caller,
 *   organizations.crud.service.js#remove, calls this AFTER the org doc and its
 *   memberships are already gone, and deliberately catches + logs each aggregated error
 *   there (best-effort) so a handler bug can never leave a zombie org or abort an
 *   unrelated caller's own work (#3965) — see that function's docblock. Config-free,
 *   import-safe leaf — it must not import organization/tasks services (avoids an
 *   import cycle).
 */

const handlers = new Set();

/**
 * @function onOrganizationRemoved
 * @description Register a cleanup handler fired when an organization is removed.
 *   Uses a Set so duplicate registrations (e.g. a module init running twice) are
 *   silently de-duped — each handler function identity is unique in the Set.
 * @param {Function} fn - async (payload) => void; payload is { organizationId, organization }.
 * @returns {void}
 */
export const onOrganizationRemoved = (fn) => {
  if (typeof fn !== 'function') throw new TypeError('onOrganizationRemoved: fn must be a function');
  handlers.add(fn);
};

/**
 * @function runOrganizationRemovedHandlers
 * @description Run every registered handler sequentially, isolating each: a handler
 *   throwing is caught so every later handler still runs, then all failures are re-raised
 *   together as a single AggregateError once the full run completes (not swallowed).
 * @param {Object} payload - { organizationId, organization }.
 * @returns {Promise<void>}
 * @throws {AggregateError} If one or more handlers threw — carries every handler error.
 */
export const runOrganizationRemovedHandlers = async (payload) => {
  const errors = [];
  for (const fn of handlers) {
    try {
      await fn(payload); // sequential: each handler must resolve before the next runs
    } catch (err) {
      errors.push(err); // isolate: a failing handler must not block the remaining ones
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} organization-removed handler(s) failed`);
  }
};

/**
 * @function _reset
 * @description Test helper — clears all registered handlers.
 * @returns {void}
 */
export const _reset = () => {
  handlers.clear();
};

export default { onOrganizationRemoved, runOrganizationRemovedHandlers, _reset };
