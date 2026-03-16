/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for billing webhook service
 */
describe('Billing webhook service unit tests:', () => {
  let BillingWebhookService;
  let mockSubscriptionRepository;
  let mockOrganizationModel;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '507f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      findByStripeSubscriptionId: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    mockOrganizationModel = {
      findByIdAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn().mockReturnValue(mockOrganizationModel),
      },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleCheckoutCompleted', () => {
    test('should create new subscription when none exists', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockSubscriptionRepository.create.mockResolvedValue({});

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId, plan: 'pro' },
      });

      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith({
        organization: orgId,
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_456',
        plan: 'pro',
        status: 'active',
      });
      expect(mockOrganizationModel.findByIdAndUpdate).toHaveBeenCalledWith(orgId, { plan: 'pro' });
    });

    test('should update existing subscription on checkout', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ _id: subId });
      mockSubscriptionRepository.update.mockResolvedValue({});

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId, plan: 'starter' },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith({
        _id: subId,
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_456',
        plan: 'starter',
        status: 'active',
      });
    });

    test('should default plan to free when metadata plan is missing', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockSubscriptionRepository.create.mockResolvedValue({});

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId },
      });

      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'free' }),
      );
    });

    test('should return early when organizationId is missing', async () => {
      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: {},
      });

      expect(mockSubscriptionRepository.findByOrganization).not.toHaveBeenCalled();
    });
  });

  describe('handleSubscriptionUpdated', () => {
    test('should update subscription when found', async () => {
      const existing = { _id: subId, organization: { _id: orgId } };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleSubscriptionUpdated({
        id: 'sub_456',
        status: 'active',
        current_period_end: 1700000000,
        cancel_at_period_end: false,
        items: { data: [{ price: { product: { metadata: { planId: 'pro' } } } }] },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith({
        _id: subId,
        plan: 'pro',
        status: 'active',
        currentPeriodEnd: new Date(1700000000 * 1000),
        cancelAtPeriodEnd: false,
      });
      expect(mockOrganizationModel.findByIdAndUpdate).toHaveBeenCalledWith(orgId, { plan: 'pro' });
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleSubscriptionUpdated({ id: 'sub_unknown', items: {} });

      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });

    test('should fall back to plan metadata from item.plan', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleSubscriptionUpdated({
        id: 'sub_456',
        status: 'active',
        current_period_end: 1700000000,
        cancel_at_period_end: true,
        items: { data: [{ plan: { metadata: { planId: 'starter' } } }] },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'starter' }),
      );
    });

    test('should default plan to free when no metadata', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleSubscriptionUpdated({
        id: 'sub_456',
        status: 'active',
        current_period_end: 1700000000,
        cancel_at_period_end: false,
        items: { data: [{}] },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'free' }),
      );
    });
  });

  describe('handleSubscriptionDeleted', () => {
    test('should cancel subscription and reset to free', async () => {
      const existing = { _id: subId, organization: { _id: orgId } };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleSubscriptionDeleted({ id: 'sub_456' });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith({
        _id: subId,
        plan: 'free',
        status: 'canceled',
      });
      expect(mockOrganizationModel.findByIdAndUpdate).toHaveBeenCalledWith(orgId, { plan: 'free' });
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleSubscriptionDeleted({ id: 'sub_unknown' });

      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('handleInvoicePaymentFailed', () => {
    test('should mark subscription as past_due', async () => {
      const existing = { _id: subId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: 'sub_456' });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith({
        _id: subId,
        status: 'past_due',
      });
    });

    test('should return early when no subscription ID in invoice', async () => {
      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: null });

      expect(mockSubscriptionRepository.findByStripeSubscriptionId).not.toHaveBeenCalled();
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: 'sub_unknown' });

      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });
  });
});
