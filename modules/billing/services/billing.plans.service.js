/**
 * Module dependencies
 */
import Stripe from 'stripe';

import config from '../../../config/index.js';

/**
 * In-memory cache for plans
 */
let cachedPlans = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

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
 * Lazily instantiated Stripe client
 */
let stripeClient = null;

/**
 * @desc Get or create the Stripe client instance
 * @returns {Object|null} Stripe client or null if not configured
 */
const getStripe = () => {
  if (stripeClient) return stripeClient;
  if (!config.stripe?.secretKey) return null;
  stripeClient = new Stripe(config.stripe.secretKey);
  return stripeClient;
};

/**
 * @desc Fetch plans from Stripe and map to normalized format
 * @param {Object} stripe - Stripe client instance
 * @returns {Promise<Array>} sorted array of plan objects
 */
const fetchPlansFromStripe = async (stripe) => {
  const products = await stripe.products.list({
    active: true,
    limit: 100,
  });

  const prices = await stripe.prices.list({
    active: true,
    limit: 100,
  });

  const pricesByProduct = {};
  for (const price of prices.data) {
    if (!pricesByProduct[price.product]) pricesByProduct[price.product] = [];
    pricesByProduct[price.product].push(price);
  }

  const plans = products.data.map((product) => {
    const productPrices = pricesByProduct[product.id] || [];

    let monthlyPrice = 0;
    let annualPrice = 0;
    let stripePriceMonthly = null;
    let stripePriceAnnual = null;

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

  const plans = await fetchPlansFromStripe(stripe);
  cachedPlans = plans;
  cacheTimestamp = Date.now();
  return plans;
};

export default {
  getPlans,
};
