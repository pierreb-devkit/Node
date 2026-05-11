/**
 * Module dependencies
 */
import logger from '../../../lib/services/logger.js';
import BillingExtraBalanceRepository from '../repositories/billing.extraBalance.repository.js';
import BillingPlanService from './billing.plan.service.js';

/**
 * @desc Service for crediting the one-shot signup grant to fresh organizations.
 *       Wraps the repository call in a best-effort try/catch so billing failures
 *       never block the signup path (N2 spec: best-effort).
 */

/**
 * @function grantOnSignup
 * @description Credit the configured signupGrant to a freshly-created organization.
 *              - Looks up the plan definition via BillingPlanService.getActivePlan.
 *              - If the plan has a signupGrant field, delegates to
 *                BillingExtraBalanceRepository.creditGrant (idempotent via refId).
 *              - If the plan has no signupGrant, returns null (no-op).
 *              - Catches all errors and logs them; NEVER throws (best-effort).
 *
 * @param {Object} params
 * @param {string} params.orgId  - The organization ObjectId (string).
 * @param {string} [params.planId='free'] - The plan identifier. Defaults to 'free' (the
 *   default fresh-signup plan — non-free signups don't flow through createOrganizationForUser).
 * @returns {Promise<Object|null>} Repository result or null (no-op / error swallowed).
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const grantOnSignup = async ({ orgId, planId = 'free' }) => {
  try {
    const plan = BillingPlanService.getActivePlan(planId);
    if (!plan) {
      logger.warn('[billing.signupGrant] plan not found — no grant credited', { orgId, planId });
      return null;
    }
    if (!plan.signupGrant) return null;

    const result = await BillingExtraBalanceRepository.creditGrant(orgId, plan.signupGrant, 'signup_grant');
    if (result?.applied === false) {
      // Idempotent no-op — org already has a signup_grant entry (e.g. admin re-ran or replay).
      logger.warn('[billing.signupGrant] duplicate grant skipped (idempotent)', { orgId, planId, reason: result.reason });
    } else {
      logger.info('[billing.signupGrant] credited', { orgId, planId, amount: plan.signupGrant, applied: result?.applied });
    }
    return result;
  } catch (err) {
    // Best-effort: billing failure MUST NOT fail signup.
    logger.error('[billing.signupGrant] failed (best-effort)', { orgId, planId, error: err?.message, stack: err?.stack });
    return null;
  }
};

export default {
  grantOnSignup,
};
