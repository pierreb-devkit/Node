/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';
import getStripe from '../lib/stripe.js';
import BillingWebhookService from '../services/billing.webhook.service.js';

/**
 * @desc Endpoint to handle Stripe webhook events
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const handleWebhook = async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(400).json({ error: 'Stripe is not configured' });

  const sig = req.headers['stripe-signature'];
  const { webhookSecret } = config.stripe;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await BillingWebhookService.withIdempotency(event, (e) =>
          BillingWebhookService.handleCheckoutSessionCompleted(e),
        );
        break;
      case 'customer.subscription.updated':
        await BillingWebhookService.withIdempotency(event, (e) =>
          BillingWebhookService.handleSubscriptionUpdated(e.data.object, e),
        );
        break;
      case 'customer.subscription.deleted':
        await BillingWebhookService.withIdempotency(event, (e) =>
          BillingWebhookService.handleSubscriptionDeleted(e.data.object),
        );
        break;
      case 'invoice.payment_failed':
        await BillingWebhookService.withIdempotency(event, (e) =>
          BillingWebhookService.handleInvoicePaymentFailed(e.data.object),
        );
        break;
      case 'invoice.payment_succeeded':
        await BillingWebhookService.withIdempotency(event, (e) =>
          BillingWebhookService.handleInvoicePaymentSucceeded(e.data.object),
        );
        break;
      case 'charge.refunded':
        await BillingWebhookService.withIdempotency(event, (e) =>
          BillingWebhookService.handleChargeRefunded(e.data.object),
        );
        break;
      default:
        break;
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Stripe webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
};

export default {
  handleWebhook,
};
