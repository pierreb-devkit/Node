/**
 * Module dependencies
 */
import getStripe from '../lib/stripe.js';
import logger from '../../../lib/services/logger.js';
import billingEvents from '../lib/events.js';

/**
 * Cache TTLs (ms)
 */
const FRESH_TTL = 5 * 60 * 1000; // 5 minutes — serve directly without Stripe call
const STALE_TTL = 24 * 60 * 60 * 1000; // 24 hours — serve stale + revalidate; beyond this: throw

/**
 * In-memory cache for plans
 */
let cachedPlans = null;
let cacheTimestamp = 0;

/**
 * Stale-while-revalidate: last known-good plans snapshot.
 * Updated only on successful Stripe fetches. Survives Stripe outages up to STALE_TTL.
 */
let stalePlans = null;
let staleTimestamp = 0;

/**
 * In-flight fetch promise — used to deduplicate concurrent cache-miss callers.
 * The /api/billing/plans route is public, so a thundering herd on cache miss
 * (e.g. cache expiry under traffic, or a small DoS) would otherwise fire N
 * parallel `stripe.products.list().autoPagingToArray()` + `stripe.prices.list()`
 * calls and exhaust the Stripe API quota — breaking live checkouts and webhook
 * signature verification. With this dedup, only one Stripe round-trip happens
 * per cache-miss window regardless of concurrency.
 */
let inFlightFetch = null;

/**
 * Default free plan returned when Stripe is not configured
 */
const DEFAULT_FREE_PLAN = {
  planId: 'free',
  name: 'Free',
  monthlyPrice: 0,
  annualPrice: 0,
  stripePriceMonthly: null,
  stripePriceAnnual: null,
};

/**
 * @desc Fetch plans from Stripe and map to normalized format
 * @param {Object} stripe - Stripe client instance
 * @returns {Promise<Array>} sorted array of plan objects
 */
const fetchPlansFromStripe = async (stripe) => {
  const [products, prices] = await Promise.all([
    stripe.products.list({ active: true }).autoPagingToArray({ limit: 1000 }),
    stripe.prices.list({ active: true }).autoPagingToArray({ limit: 1000 }),
  ]);

  const pricesByProduct = {};
  for (const price of prices) {
    if (!pricesByProduct[price.product]) pricesByProduct[price.product] = [];
    pricesByProduct[price.product].push(price);
  }

  // Build reverse-lookup: priceId → [planId, ...] to detect price ID reuse across plans.
  // A Stripe price ID mapped to multiple plans is a configuration error that causes silent
  // billing misrouting — warn explicitly with both plan IDs + the duplicate price ID.
  const priceIdToPlanIds = {};

  const plans = products.map((product) => {
    const productPrices = pricesByProduct[product.id] || [];
    const planId = product.metadata?.planId || product.id;

    let monthlyPrice = 0;
    let annualPrice = 0;
    let stripePriceMonthly = null;
    let stripePriceAnnual = null;

    // Expects one active price per interval per product; last match wins if duplicates exist
    for (const price of productPrices) {
      const amount = typeof price.unit_amount === 'number' ? price.unit_amount : 0;
      if (price.recurring?.interval === 'month') {
        monthlyPrice = amount / 100;
        stripePriceMonthly = price.id;
      } else if (price.recurring?.interval === 'year') {
        annualPrice = amount / 100;
        stripePriceAnnual = price.id;
      }
      // Track price-to-plan mapping for duplicate detection
      if (price.id) {
        if (!priceIdToPlanIds[price.id]) priceIdToPlanIds[price.id] = [];
        priceIdToPlanIds[price.id].push(planId);
      }
    }

    return {
      planId,
      name: product.name,
      monthlyPrice,
      annualPrice,
      stripePriceMonthly,
      stripePriceAnnual,
    };
  });

  // Emit explicit warn for any Stripe price ID mapped to more than one plan.
  // This is a Stripe account configuration error that causes silent billing misrouting.
  for (const [priceId, planIds] of Object.entries(priceIdToPlanIds)) {
    if (planIds.length > 1) {
      logger.warn('[billing.plans] duplicate Stripe price ID mapped to multiple plans — config error', {
        priceId,
        planIds,
      });
    }
  }

  return plans.sort((a, b) => a.monthlyPrice - b.monthlyPrice);
};

/**
 * @desc Get billing plans with stale-while-revalidate caching.
 *
 * Cache tiers:
 *   - Fresh (< FRESH_TTL=5min): return in-memory cache directly, no Stripe call.
 *   - Stale (5min–24h): attempt Stripe fetch; on failure, return last known-good
 *     snapshot + log warning + emit billing.plans.stale. Protects plans endpoint
 *     during transient Stripe outages.
 *   - Expired (> 24h stale): throw — clients get a 503 but new checkouts would
 *     fail at Stripe anyway, so serving a 24h-old plan list adds no value.
 *
 * In-flight dedup: only one Stripe round-trip per cache-miss window regardless
 * of concurrency (thundering-herd protection for the public plans endpoint).
 *
 * @returns {Promise<Array>} array of plan objects sorted by monthlyPrice ascending
 */
const getPlans = async () => {
  const stripe = getStripe();
  if (!stripe) return [DEFAULT_FREE_PLAN];

  const now = Date.now();

  // Fresh cache hit — return immediately, no Stripe call
  if (cachedPlans && now - cacheTimestamp < FRESH_TTL) return cachedPlans;

  // In-flight dedup: if another caller is already fetching, await its result
  // instead of issuing parallel Stripe API calls. Reset on completion so the
  // next cache miss can issue a fresh fetch (success OR failure — failures must
  // not poison the slot, otherwise the next call retries cleanly).
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
    try {
      const plans = await fetchPlansFromStripe(stripe);
      cachedPlans = plans;
      cacheTimestamp = Date.now();
      // Update stale snapshot on every successful fetch
      stalePlans = plans;
      staleTimestamp = Date.now();
      return plans;
    } catch (err) {
      // Stripe unavailable — attempt stale fallback.
      // Use Date.now() here (not the captured `now`) to account for the time
      // spent inside the Stripe round-trip: entries near the 24h boundary
      // must be evaluated at the moment the catch runs, not at function entry.
      const staleAge = Date.now() - staleTimestamp;
      if (stalePlans && staleAge < STALE_TTL) {
        logger.warn('[billing.plans] Stripe unavailable — serving stale plans cache', {
          staleAgeMs: staleAge,
          err: err?.message ?? String(err),
        });
        billingEvents.emit('billing.plans.stale', { staleAgeMs: staleAge });
        // Update in-memory cache timestamp so next call within FRESH_TTL skips Stripe
        cachedPlans = stalePlans;
        cacheTimestamp = Date.now();
        return stalePlans;
      }
      // Stale TTL exceeded — re-throw so callers can surface a proper error
      throw err;
    } finally {
      inFlightFetch = null;
    }
  })();

  return inFlightFetch;
};

/**
 * @desc Reset the in-memory plan cache.
 *
 * Exposed for test isolation: each test that exercises different Stripe configurations
 * should call `clearPlansCache()` in `beforeEach`/`afterEach` to prevent stale module-scope
 * state from leaking between test files (ESM module cache is per-worker but shared across
 * tests in the same worker file when `jest.resetModules()` is not in use).
 *
 * NOT intended for production use — the cache is self-refreshing via stale-while-revalidate.
 */
const clearPlansCache = () => {
  cachedPlans = null;
  cacheTimestamp = 0;
  stalePlans = null;
  staleTimestamp = 0;
  inFlightFetch = null;
};

export default {
  getPlans,
  clearPlansCache,
};
