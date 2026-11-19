/**
 * @module organizations/lib/organizations.removal.registry
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
 *
 *   Guards (`onBeforeOrganizationRemoved`) are the other half: they run BEFORE anything
 *   is deleted and may REFUSE the removal by throwing (an AppError with a 4xx status,
 *   e.g. an optional module refusing while a paid subscription is live). Unlike handlers they are
 *   not isolated: the first throw stops the run and propagates unchanged to the caller.
 */

const guards = new Set();
const handlers = new Set();

/**
 * @function onBeforeOrganizationRemoved
 * @description Register a guard run before an organization is removed. A guard refuses
 *   the removal by throwing (an AppError with a 4xx status and a stable code is what a
 *   client can show); resolving lets the removal go on. De-duped like handlers.
 * @param {Function} fn - async (payload) => void; payload is { organizationId, organization }.
 * @returns {void}
 */
export const onBeforeOrganizationRemoved = (fn) => {
  if (typeof fn !== 'function') throw new TypeError('onBeforeOrganizationRemoved: fn must be a function');
  guards.add(fn);
};

/**
 * @function runBeforeOrganizationRemovedGuards
 * @description Run every registered guard sequentially. The first guard that throws stops
 *   the run and its error propagates as-is (never wrapped), so its status/code reach the client.
 * @param {Object} payload - { organizationId, organization }.
 * @returns {Promise<void>}
 * @throws {Error} The first guard error — the removal must not proceed.
 */
export const runBeforeOrganizationRemovedGuards = async (payload) => {
  for (const fn of guards) {
    await fn(payload); // sequential, fail-fast: a refusal stops the removal
  }
};

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
 * @description Test helper — clears all registered guards and handlers.
 * @returns {void}
 */
export const _reset = () => {
  guards.clear();
  handlers.clear();
};

export default { onBeforeOrganizationRemoved, runBeforeOrganizationRemovedGuards, onOrganizationRemoved, runOrganizationRemovedHandlers, _reset };
