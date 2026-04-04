/**
 * Module dependencies
 */
import crypto from 'crypto';
import WebhookRepository from '../repositories/developers.webhook.repository.js';
import WebhookDeliveryRepository from '../repositories/developers.webhookDelivery.repository.js';

const TIMEOUT_MS = 10000;
const RESPONSE_BODY_MAX = 1000;

/**
 * Retry delay schedule (in ms) indexed by attempt number (1-based).
 * Attempt 1: +1min, Attempt 2: +5min, Attempt 3: +30min
 */
const RETRY_DELAYS = {
  1: 60 * 1000,
  2: 5 * 60 * 1000,
  3: 30 * 60 * 1000,
};

/**
 * @function signPayload
 * @description Sign a JSON payload with HMAC-SHA256.
 * @param {string} payload - JSON string
 * @param {string} secret - Webhook secret
 * @returns {string} hex signature
 */
const signPayload = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

/**
 * @function deliverWebhook
 * @description Deliver a payload to a single webhook endpoint and record the delivery.
 * @param {Object} webhook - The webhook Mongoose document
 * @param {string} event - The event type
 * @param {Object} payload - The event payload
 * @returns {Promise<Object>} The delivery record
 */
const deliverWebhook = async (webhook, event, payload) => {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, webhook.secret);

  const delivery = await WebhookDeliveryRepository.create({
    webhook: webhook._id,
    event,
    payload,
    organizationId: webhook.organizationId,
  });

  const start = Date.now();
  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Event': event,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const responseText = await response.text().catch(() => '');
    const duration = Date.now() - start;
    const isSuccess = response.status >= 200 && response.status < 300;

    delivery.statusCode = response.status;
    delivery.responseBody = responseText.substring(0, RESPONSE_BODY_MAX);
    delivery.duration = duration;
    delivery.success = isSuccess;
    delivery.attempts = 1;

    if (!isSuccess) {
      delivery.nextRetryAt = new Date(Date.now() + RETRY_DELAYS[1]);
    }

    await WebhookDeliveryRepository.update(delivery);
    return delivery;
  } catch (err) {
    const duration = Date.now() - start;
    delivery.responseBody = (err.message || 'Unknown error').substring(0, RESPONSE_BODY_MAX);
    delivery.duration = duration;
    delivery.success = false;
    delivery.attempts = 1;
    delivery.nextRetryAt = new Date(Date.now() + RETRY_DELAYS[1]);

    await WebhookDeliveryRepository.update(delivery);
    return delivery;
  }
};

/**
 * @function dispatch
 * @description Dispatch an event to all active webhooks for the given org.
 * @param {string} event - The event type
 * @param {Object} payload - The event payload
 * @param {String} organizationId - The organization ID
 * @returns {Promise<void>}
 */
const dispatch = async (event, payload, organizationId) => {
  const webhooks = await WebhookRepository.findByEvent(event, organizationId);
  for (const webhook of webhooks) {
    deliverWebhook(webhook, event, payload).catch((err) => console.error(`Webhook dispatch failed for ${webhook._id}:`, err.message));
  }
};

/**
 * @function retryPending
 * @description Find and re-deliver all pending retries, incrementing attempt counts.
 * @returns {Promise<void>}
 */
const retryPending = async () => {
  const deliveries = await WebhookDeliveryRepository.findPendingRetries();

  for (const delivery of deliveries) {
    const webhook = await WebhookRepository.get(String(delivery.webhook));
    if (!webhook || !webhook.active) continue;

    const body = JSON.stringify(delivery.payload);
    const signature = signPayload(body, webhook.secret);
    const nextAttempt = delivery.attempts + 1;

    const start = Date.now();
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Webhook-Event': delivery.event,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const responseText = await response.text().catch(() => '');
      const duration = Date.now() - start;
      const isSuccess = response.status >= 200 && response.status < 300;

      delivery.statusCode = response.status;
      delivery.responseBody = responseText.substring(0, RESPONSE_BODY_MAX);
      delivery.duration = duration;
      delivery.success = isSuccess;
      delivery.attempts = nextAttempt;
      delivery.nextRetryAt = (!isSuccess && nextAttempt < 3)
        ? new Date(Date.now() + (RETRY_DELAYS[nextAttempt] || RETRY_DELAYS[3]))
        : null;

      await WebhookDeliveryRepository.update(delivery);
    } catch (err) {
      const duration = Date.now() - start;
      delivery.responseBody = (err.message || 'Unknown error').substring(0, RESPONSE_BODY_MAX);
      delivery.duration = duration;
      delivery.success = false;
      delivery.attempts = nextAttempt;
      delivery.nextRetryAt = nextAttempt < 3
        ? new Date(Date.now() + (RETRY_DELAYS[nextAttempt] || RETRY_DELAYS[3]))
        : null;

      await WebhookDeliveryRepository.update(delivery);
    }
  }
};

/**
 * @function sendTestPing
 * @description Deliver a test ping event to a webhook.
 * @param {Object} webhook - The webhook Mongoose document
 * @returns {Promise<Object>} The delivery record
 */
const sendTestPing = (webhook) => deliverWebhook(webhook, 'ping', { event: 'ping', timestamp: new Date().toISOString() });

export { signPayload };

export default {
  dispatch,
  deliverWebhook,
  retryPending,
  sendTestPing,
  signPayload,
};
