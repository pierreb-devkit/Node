/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';

/**
 * Valid plan names from config (immutable set for O(1) lookups).
 */
const validPlans = new Set(config.billing?.plans || ['free', 'starter', 'pro', 'enterprise']);

/**
 * Build a reverse-map from Stripe price ID → plan name, sourced from `config.stripe.prices`
 * at module load. Shape: `{ starter: { monthly: 'price_xxx', annual: 'price_yyy' }, pro: {...} }`.
 *
 * Why: `price.metadata.planId` is empty on real Stripe payloads — `planId` lives on the
 * Product, not the Price exposed by webhook/subscription objects. The reverse-map gives a
 * robust priceId→plan lookup without an extra Stripe API call.
 *
 * Shared by the webhook handler, the admin force-sync tool, and the reconcile cron so all
 * three resolve identically (#3964 / #1250 — the admin + reconcile copies had drifted into
 * a metadata-only resolver that silently fell back to 'free' for every real subscription).
 *
 * @returns {Record<string, string>} priceId → planId map (built once at module init)
 */
export const buildPriceIdToPlanMap = () => {
  const map = {};
  const stripePrices = config.stripe?.prices || {};
  for (const [planId, intervals] of Object.entries(stripePrices)) {
    if (!validPlans.has(planId)) continue;
    if (intervals?.monthly) map[intervals.monthly] = planId;
    if (intervals?.annual) map[intervals.annual] = planId;
  }
  return map;
};

const priceIdToPlan = buildPriceIdToPlanMap();

/**
 * @description Look up the plan for a raw Stripe price ID (no subscription object needed).
 * Used when only a bare price ID is available (e.g. reading `previous_attributes` on a
 * webhook diff, where the previous line item is a partial object, not a full subscription).
 * @param {string|undefined} priceId - Stripe price ID (price_xxx).
 * @returns {string|undefined} plan name, or undefined when the price ID is not mapped.
 */
export const lookupPlanByPriceId = (priceId) => (priceId ? priceIdToPlan[priceId] : undefined);

/**
 * @description Resolve the plan name from a Stripe subscription object.
 * Strategy (most-specific first):
 *   1. config priceId map (price_xxx → planId) — robust, no metadata dependency.
 *   2. price.metadata.planId / plan.metadata.planId legacy fallback (test fixtures, manual
 *      Stripe edits) — validated against the known plan enum.
 *   3. `null` when nothing resolves — deliberately NOT 'free'. Silently downgrading an
 *      unresolvable paid subscription to 'free' is the exact defect this resolver replaces;
 *      the caller decides the safe behavior for its context (log-only vs a DB write).
 * @param {Object} subscription - Stripe subscription object.
 * @param {Object} [opts]
 * @param {string} [opts.logPrefix] - Log tag for the caller module (e.g. '[billing.admin]').
 * @returns {string|null} plan name, or null when unresolved.
 */
export const resolvePlanFromSubscription = (subscription, { logPrefix = '[billing]' } = {}) => {
  const item = subscription?.items?.data?.[0];
  const priceId = item?.price?.id;
  if (priceId && priceIdToPlan[priceId]) {
    return priceIdToPlan[priceId];
  }

  // Legacy fallback: price/plan metadata set explicitly (e.g. test fixtures or manual Stripe edits).
  const rawMeta = item?.price?.metadata?.planId || item?.plan?.metadata?.planId;
  if (rawMeta) {
    if (validPlans.has(rawMeta)) return rawMeta;
    logger.warn(`${logPrefix} resolvePlanFromSubscription: unrecognized planId in metadata`, {
      raw: rawMeta,
      validPlans: [...validPlans],
    });
    return null;
  }

  // Nothing resolved — warn so a misconfigured config.stripe.prices (or an unmapped plan
  // such as a manually-sold enterprise price) is visible instead of silently downgrading.
  if (priceId) {
    logger.warn(`${logPrefix} resolvePlanFromSubscription: priceId not in priceIdToPlan map and no metadata`, {
      priceId,
      stripeSubscriptionId: subscription?.id,
    });
  }
  return null;
};

export default { buildPriceIdToPlanMap, resolvePlanFromSubscription, lookupPlanByPriceId };
