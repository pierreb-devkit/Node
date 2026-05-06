/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for billing webhook controller
 */
describe('Billing webhook controller unit tests:', () => {
  let BillingWebhookController;
  let mockBillingWebhookService;
  let mockStripeInstance;
  let res;

  beforeEach(async () => {
    jest.resetModules();

    mockBillingWebhookService = {
      withIdempotency: jest.fn().mockImplementation(async (event, handler) => handler(event)),
      handleCheckoutSessionCompleted: jest.fn().mockResolvedValue(),
      handleCheckoutCompleted: jest.fn().mockResolvedValue(),
      handleCheckoutPaymentCompleted: jest.fn().mockResolvedValue(),
      handleSubscriptionUpdated: jest.fn().mockResolvedValue(),
      handleSubscriptionDeleted: jest.fn().mockResolvedValue(),
      handleInvoicePaymentFailed: jest.fn().mockResolvedValue(),
      handleInvoicePaymentSucceeded: jest.fn().mockResolvedValue(),
      handleChargeRefunded: jest.fn().mockResolvedValue(),
      handleCustomerDeleted: jest.fn().mockResolvedValue(),
      handleChargeDisputeCreated: jest.fn().mockResolvedValue(),
      handleChargeDisputeFundsWithdrawn: jest.fn().mockResolvedValue(),
    };

    jest.unstable_mockModule('../services/billing.webhook.service.js', () => ({
      default: mockBillingWebhookService,
    }));

    mockStripeInstance = {
      webhooks: {
        constructEvent: jest.fn(),
      },
    };

    jest.unstable_mockModule('stripe', () => ({
      default: jest.fn(() => mockStripeInstance),
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      },
    }));

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should return 400 when stripe is not configured', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: {} },
    }));

    const mod = await import('../controllers/billing.webhook.controller.js');
    BillingWebhookController = mod.default;

    const req = { headers: {}, body: '' };
    await BillingWebhookController.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Bad Request',
      description: 'Stripe is not configured',
    }));
  });

  test('should return 400 when signature verification fails', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: { secretKey: 'sk_test_1', webhookSecret: 'whsec_1' } },
    }));

    mockStripeInstance.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('bad signature');
    });

    const mod = await import('../controllers/billing.webhook.controller.js');
    BillingWebhookController = mod.default;

    const req = { headers: { 'stripe-signature': 'sig_bad' }, body: 'raw' };
    await BillingWebhookController.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Bad Request',
      description: 'Webhook signature verification failed',
    }));
  });

  test('should handle checkout.session.completed event', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: { secretKey: 'sk_test_2', webhookSecret: 'whsec_2' } },
    }));

    const eventData = { type: 'checkout.session.completed', data: { object: { id: 'cs_123' } } };
    mockStripeInstance.webhooks.constructEvent.mockReturnValue(eventData);

    const mod = await import('../controllers/billing.webhook.controller.js');
    BillingWebhookController = mod.default;

    const req = { headers: { 'stripe-signature': 'sig_ok' }, body: 'raw' };
    await BillingWebhookController.handleWebhook(req, res);

    expect(mockBillingWebhookService.handleCheckoutSessionCompleted).toHaveBeenCalledWith(eventData);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  test('should handle customer.subscription.updated event', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: { secretKey: 'sk_test_3', webhookSecret: 'whsec_3' } },
    }));

    const eventData = { type: 'customer.subscription.updated', data: { object: { id: 'sub_123' } } };
    mockStripeInstance.webhooks.constructEvent.mockReturnValue(eventData);

    const mod = await import('../controllers/billing.webhook.controller.js');
    BillingWebhookController = mod.default;

    const req = { headers: { 'stripe-signature': 'sig_ok' }, body: 'raw' };
    await BillingWebhookController.handleWebhook(req, res);

    expect(mockBillingWebhookService.handleSubscriptionUpdated).toHaveBeenCalledWith({ id: 'sub_123' }, eventData);
    expect(mockBillingWebhookService.withIdempotency).toHaveBeenCalledWith(eventData, expect.any(Function), expect.objectContaining({}));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('should handle customer.subscription.deleted event', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: { secretKey: 'sk_test_4', webhookSecret: 'whsec_4' } },
    }));

    const eventData = { type: 'customer.subscription.deleted', data: { object: { id: 'sub_del' } } };
    mockStripeInstance.webhooks.constructEvent.mockReturnValue(eventData);

    const mod = await import('../controllers/billing.webhook.controller.js');
    BillingWebhookController = mod.default;

    const req = { headers: { 'stripe-signature': 'sig_ok' }, body: 'raw' };
    await BillingWebhookController.handleWebhook(req, res);

    expect(mockBillingWebhookService.handleSubscriptionDeleted).toHaveBeenCalledWith({ id: 'sub_del' }, eventData);
    expect(mockBillingWebhookService.withIdempotency).toHaveBeenCalledWith(eventData, expect.any(Function), expect.objectContaining({}));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('should handle invoice.payment_failed event', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: { secretKey: 'sk_test_5', webhookSecret: 'whsec_5' } },
    }));

    const eventData = { type: 'invoice.payment_failed', data: { object: { id: 'inv_fail' } } };
    mockStripeInstance.webhooks.constructEvent.mockReturnValue(eventData);

    const mod = await import('../controllers/billing.webhook.controller.js');
    BillingWebhookController = mod.default;

    const req = { headers: { 'stripe-signature': 'sig_ok' }, body: 'raw' };
    await BillingWebhookController.handleWebhook(req, res);

    expect(mockBillingWebhookService.handleInvoicePaymentFailed).toHaveBeenCalledWith({ id: 'inv_fail' }, eventData);
    expect(mockBillingWebhookService.withIdempotency).toHaveBeenCalledWith(eventData, expect.any(Function), expect.objectContaining({}));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('should handle charge.dispute.funds_withdrawn event', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: { secretKey: 'sk_test_fw', webhookSecret: 'whsec_fw' } },
    }));

    const eventData = { type: 'charge.dispute.funds_withdrawn', data: { object: { id: 'dp_fw_1', charge: 'ch_1', amount: 2900 } } };
    mockStripeInstance.webhooks.constructEvent.mockReturnValue(eventData);

    const mod = await import('../controllers/billing.webhook.controller.js');
    BillingWebhookController = mod.default;

    const req = { headers: { 'stripe-signature': 'sig_ok' }, body: 'raw' };
    await BillingWebhookController.handleWebhook(req, res);

    expect(mockBillingWebhookService.handleChargeDisputeFundsWithdrawn).toHaveBeenCalledWith(
      { id: 'dp_fw_1', charge: 'ch_1', amount: 2900 },
      eventData,
    );
    expect(mockBillingWebhookService.withIdempotency).toHaveBeenCalledWith(eventData, expect.any(Function), expect.objectContaining({}));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('should return 200 for unknown event types', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: { secretKey: 'sk_test_6', webhookSecret: 'whsec_6' } },
    }));

    const eventData = { type: 'unknown.event', data: { object: {} } };
    mockStripeInstance.webhooks.constructEvent.mockReturnValue(eventData);

    const mod = await import('../controllers/billing.webhook.controller.js');
    BillingWebhookController = mod.default;

    const req = { headers: { 'stripe-signature': 'sig_ok' }, body: 'raw' };
    await BillingWebhookController.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  test('should return 500 when handler throws', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: { secretKey: 'sk_test_7', webhookSecret: 'whsec_7' } },
    }));

    const eventData = { type: 'checkout.session.completed', data: { object: { id: 'cs_err' } } };
    mockStripeInstance.webhooks.constructEvent.mockReturnValue(eventData);
    mockBillingWebhookService.handleCheckoutSessionCompleted.mockRejectedValue(new Error('DB error'));

    const mod = await import('../controllers/billing.webhook.controller.js');
    BillingWebhookController = mod.default;

    const loggerMod = await import('../../../lib/services/logger.js');
    const req = { headers: { 'stripe-signature': 'sig_ok' }, body: 'raw' };
    await BillingWebhookController.handleWebhook(req, res);

    expect(loggerMod.default.error).toHaveBeenCalledWith(
      '[billing.webhook] handler error',
      expect.objectContaining({ error: 'DB error' }),
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Internal Server Error',
      description: 'Webhook handler failed',
    }));
  });
});
