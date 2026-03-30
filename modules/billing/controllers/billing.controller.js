/**
 * Module dependencies
 */
import { activeStatuses } from '../lib/constants.js';
import config from '../../../config/index.js';
import responses from '../../../lib/helpers/responses.js';
import BillingService from '../services/billing.service.js';
import BillingUsageService from '../services/billing.usage.service.js';

/**
 * @desc Endpoint to create a Stripe Checkout session
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const checkout = async (req, res) => {
  try {
    const { priceId, successUrl, cancelUrl } = req.body;
    const url = await BillingService.createCheckout(req.organization, priceId, successUrl, cancelUrl);
    responses.success(res, 'checkout session created')({ url });
  } catch (err) {
    const status = err.message?.startsWith('Invalid') || err.message?.includes('not found') ? 422 : 502;
    const title = status === 422 ? 'Unprocessable Entity' : 'Bad Gateway';
    responses.error(res, status, title, 'Failed to create checkout session')(err);
  }
};

/**
 * @desc Endpoint to create a Stripe Customer Portal session
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const portal = async (req, res) => {
  try {
    const { returnUrl } = req.body;
    const url = await BillingService.createPortalSession(req.organization, returnUrl);
    responses.success(res, 'portal session created')({ url });
  } catch (err) {
    const status = err.message?.startsWith('Invalid') || err.message?.includes('not found') ? 422 : 502;
    const title = status === 422 ? 'Unprocessable Entity' : 'Bad Gateway';
    responses.error(res, status, title, 'Failed to create portal session')(err);
  }
};

/**
 * @desc Endpoint to get the subscription for the current organization
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const getSubscription = async (req, res) => {
  try {
    const subscription = await BillingService.getSubscription(req.organization._id);
    responses.success(res, 'subscription')(subscription);
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to retrieve subscription')(err);
  }
};

/**
 * @desc Endpoint to get billing usage for the current organization
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const getUsage = async (req, res) => {
  try {
    // Determine current plan via service layer
    const subscription = await BillingService.getSubscription(req.organization._id);
    const plan = (!subscription || !activeStatuses.includes(subscription.status)) ? 'free' : (subscription.plan || 'free');

    // Get usage counters (includes month field)
    const usage = await BillingUsageService.get(req.organization._id.toString());

    // Flatten quotas config into { "resource.action": limit } format
    // Normalize Infinity to null for JSON-safe serialization
    const quotas = config.billing?.quotas;
    let limits = {};
    if (quotas?.[plan]) {
      const planQuotas = quotas[plan];
      for (const resource of Object.keys(planQuotas)) {
        for (const action of Object.keys(planQuotas[resource])) {
          const rawLimit = planQuotas[resource][action];
          limits[`${resource}_${action}`] = Number.isFinite(rawLimit) ? rawLimit : null;
        }
      }
    }

    responses.success(res, 'billing usage')({
      plan,
      period: usage.month,
      usage: usage.counters || {},
      limits,
    });
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to retrieve billing usage')(err);
  }
};

export default {
  checkout,
  portal,
  getSubscription,
  getUsage,
};
