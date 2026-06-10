/**
 * Generic signup-eligibility hook registry.
 *
 * Inverts the auth → invitations dependency: auth never imports invitation code.
 * Optional modules (e.g. invitations) register a check at boot via
 * registerSignupEligibility; auth runs them all in the signup / OAuth paths.
 *
 * Each check (a) may THROW an AppError to block signup, and (b) may RETURN a
 * result object that auth hands back verbatim to whoever cares. The result is
 * OPAQUE to auth — auth never reads its shape, it just relays the first non-null
 * one. This is the return-value seam that replaces stashing carrier props on req.
 */

const checks = [];

/**
 * Register a signup eligibility check. Each fn(ctx) may throw an AppError to block
 * signup, and/or return a result object (opaque to auth) — or undefined.
 * @param {(ctx: { email?: string, body?: Object, req?: Object, oauth?: Object }) => (any|Promise<any>)} fn
 * @returns {void}
 */
export const registerSignupEligibility = (fn) => {
  if (typeof fn !== 'function') {
    throw new TypeError('registerSignupEligibility: fn must be a function');
  }
  checks.push(fn);
};

/**
 * Run EVERY registered eligibility check with the same ctx. A check may throw
 * (to block signup — propagated to the caller) and/or return a result object.
 * Returns the FIRST non-null result collected across all checks (in registration
 * order), or null when no check returned one. The result is opaque to auth: it is
 * handed straight back to the caller (e.g. the invitations checker returns
 * `{ invite, finalize, release }`, which auth relays without importing any invitation code).
 *
 * NOTE for future check authors (P5/P8 will register more): a THROW from ANY
 * check aborts the whole chain and blocks signup — even a check that runs AFTER
 * an earlier one already resolved a non-null result. Throwing is "block signup",
 * not "I have no opinion"; return `undefined` for the latter. Order matters.
 * @param {{ email?: string, body?: Object, req?: Object, oauth?: Object }} ctx
 * @returns {Promise<any|null>} the first non-null check result, or null
 */
export const assertSignupEligible = async (ctx) => {
  let result = null;
  for (const check of checks) {
    const r = await check(ctx);
    // Loose `== null`: a check returning either undefined or null counts as "no
    // result" (a check can `return;` to mean "no opinion"). First non-null wins.
    if (result == null && r != null) result = r;
  }
  return result;
};

/**
 * Test helper — clears the registry (mirrors discoverPolicies registry clearing).
 * @returns {void}
 */
export const _reset = () => {
  checks.length = 0;
};

export default { registerSignupEligibility, assertSignupEligible, _reset };
