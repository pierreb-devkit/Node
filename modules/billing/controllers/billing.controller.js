/**
 * Module dependencies
 */
import responses from '../../../lib/helpers/responses.js';
import BillingService from '../services/billing.service.js';

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

export default {
  checkout,
  portal,
  getSubscription,
};
