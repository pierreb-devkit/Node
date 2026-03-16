/**
 * Module dependencies
 */
import Stripe from 'stripe';

import config from '../../../config/index.js';
import BillingWebhookService from '../services/billing.webhook.service.js';

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
 * @desc Endpoint to handle Stripe webhook events
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const handleWebhook = async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(400).json({ error: 'Stripe is not configured' });

  const sig = req.headers['stripe-signature'];
  const { webhookSecret } = config.stripe;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await BillingWebhookService.handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.updated':
        await BillingWebhookService.handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await BillingWebhookService.handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_failed':
        await BillingWebhookService.handleInvoicePaymentFailed(event.data.object);
        break;
      default:
        break;
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
};

export default {
  handleWebhook,
};
