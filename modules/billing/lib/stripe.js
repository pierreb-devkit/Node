/**
 * Module dependencies
 */
import Stripe from 'stripe';

import config from '../../../config/index.js';

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

export default getStripe;
