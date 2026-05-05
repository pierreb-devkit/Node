/**
 * Module dependencies
 */
import getStripe from '../lib/stripe.js';

/**
 * In-memory cache for plans
 */
let cachedPlans = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

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

  const plans = products.map((product) => {
    const productPrices = pricesByProduct[product.id] || [];

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
    }

    return {
      planId: product.metadata?.planId || product.id,
      name: product.name,
      monthlyPrice,
      annualPrice,
      stripePriceMonthly,
      stripePriceAnnual,
    };
  });

  return plans.sort((a, b) => a.monthlyPrice - b.monthlyPrice);
};

/**
 * @desc Get billing plans with in-memory caching
 * @returns {Promise<Array>} array of plan objects sorted by monthlyPrice ascending
 */
const getPlans = async () => {
  const stripe = getStripe();
  if (!stripe) return [DEFAULT_FREE_PLAN];

  const now = Date.now();
  if (cachedPlans && now - cacheTimestamp < CACHE_TTL) return cachedPlans;

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
      return plans;
    } finally {
      inFlightFetch = null;
    }
  })();

  return inFlightFetch;
};

export default {
  getPlans,
};
