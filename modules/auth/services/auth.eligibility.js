/**
 * Generic signup-eligibility hook registry.
 *
 * Inverts the auth → invitations dependency: auth never imports invitation code.
 * Optional modules (e.g. invitations) register a check at boot via
 * registerSignupEligibility; auth runs them all in the signup / OAuth paths.
 * Each check receives a ctx and throws an AppError to block signup.
 */

const checks = [];

/**
 * Register a signup eligibility check. Each fn(ctx) throws an AppError to block.
 * @param {(ctx: { email?: string, body?: Object, req?: Object }) => (void|Promise<void>)} fn
 * @returns {void}
 */
export const registerSignupEligibility = (fn) => {
  checks.push(fn);
};

/**
 * Run all registered checks. ctx = { email, body, req }. Throws to block signup.
 * @param {{ email?: string, body?: Object, req?: Object }} ctx
 * @returns {Promise<void>}
 */
export const assertSignupEligible = async (ctx) => {
  for (const check of checks) await check(ctx);
};

/**
 * Test helper — clears the registry (mirrors discoverPolicies registry clearing).
 * @returns {void}
 */
export const _reset = () => {
  checks.length = 0;
};

export default { registerSignupEligibility, assertSignupEligible, _reset };
