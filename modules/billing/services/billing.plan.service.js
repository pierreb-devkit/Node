/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';

/**
 * @desc Resolve a plan definition from config.billing.planDefinitions.
 *       Returns a plan-like object compatible with the previous DB-backed API.
 *
 * @param {string} planId - The logical plan identifier (e.g. "pro").
 * @returns {Object|null} Plan object with meterQuota, ratios, version, and optional
 *          signupGrant / oneShot fields (N2 signup-grant feature), or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getPlanFromConfig = (planId) => {
  const definitions = config?.billing?.planDefinitions ?? [];
  const def = definitions.find((d) => d.planId === planId);
  if (!def) return null;

  const version =
    def.version
    ?? config?.billing?.meter?.ratioVersion
    ?? 'v1';

  const plan = {
    planId: def.planId,
    version,
    meterQuota: def.meterQuota ?? 0,
    ratios: def.ratios ?? {},
  };

  // N2 signup-grant fields — only present when configured (optional on the def).
  // Guard: signupGrant and oneShot must be defined together (co-presence invariant).
  // This mirrors the Zod schema refine() and catches misconfigured planDefinitions at runtime.
  const hasGrant = def.signupGrant !== undefined;
  const hasOneShot = def.oneShot !== undefined;
  if (hasGrant !== hasOneShot) {
    logger.warn(
      '[billing.plan] signupGrant and oneShot must be defined together — check planDefinitions config',
      { planId: def.planId, signupGrant: def.signupGrant, oneShot: def.oneShot },
    );
  }
  if (hasGrant) plan.signupGrant = def.signupGrant;
  if (hasOneShot) plan.oneShot = def.oneShot;

  return plan;
};

/**
 * @desc Get the active plan for a given planId (config-static, no DB read).
 *       Returns null when no plan definition is found for the given planId.
 *       Callers must handle null as a hard error when meterMode is enabled.
 *
 * @param {string} planId - The logical plan identifier (e.g. "pro").
 * @returns {Object|null} The plan object, or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getActivePlan = (planId) => getPlanFromConfig(planId);

/**
 * @desc Get an immutable plan snapshot by (planId, version).
 *       Useful for replay / attribution on historical records.
 *       Returns null when the version does not match the configured version.
 *
 * @param {string} planId - The logical plan identifier.
 * @param {string} version - The specific version string.
 * @returns {Object|null} The plan object if the version matches, or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getPlanByVersion = (planId, version) => {
  const plan = getPlanFromConfig(planId);
  if (!plan) return null;
  if (plan.version !== version) return null;
  return plan;
};

export default {
  getActivePlan,
  getPlanByVersion,
};
