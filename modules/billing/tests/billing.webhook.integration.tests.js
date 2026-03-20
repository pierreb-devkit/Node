/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Integration tests for billing webhook service
 */
describe('Billing webhook integration tests:', () => {
  let WebhookService;
  let mockSubscriptionRepository;
  let mockOrganizationModel;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      findByStripeCustomerId: jest.fn(),
      findByStripeSubscriptionId: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    mockOrganizationModel = {
      findByIdAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
    };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('mongoose', () => {
      const actualTypes = {
        ObjectId: {
          isValid: (id) => /^[a-f\d]{24}$/i.test(id),
        },
      };
      return {
        default: {
          Types: actualTypes,
          model: (name) => {
            if (name === 'Organization') return mockOrganizationModel;
            return {};
          },
        },
      };
    });

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: {
          plans: ['free', 'starter', 'pro', 'enterprise'],
        },
      },
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn() },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    WebhookService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleCheckoutCompleted', () => {
    test('should update existing subscription with valid metadata plan', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId, plan: 'pro' },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ _id: subId, plan: 'pro', status: 'active' }),
      );
      expect(mockOrganizationModel.findByIdAndUpdate).toHaveBeenCalledWith(
        orgId, { plan: 'pro' }, { runValidators: true },
      );
    });

    test('should create subscription when none exists', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockSubscriptionRepository.create.mockResolvedValue({});

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId, plan: 'starter' },
      });

      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organization: orgId,
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_456',
          plan: 'starter',
          status: 'active',
        }),
      );
    });

    test('should fall back to free when metadata plan is invalid (e.g. Stripe product ID)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId, plan: 'prod_ABC123xyz' },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'free' }),
      );
    });

    test('should fall back to free when metadata plan is missing', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'free' }),
      );
    });

    test('should handle missing organizationId by resolving from stripeCustomerId', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(existing);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { plan: 'pro' },
      });

      expect(mockSubscriptionRepository.findByStripeCustomerId).toHaveBeenCalledWith('cus_123');
      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'pro', status: 'active' }),
      );
    });

    test('should return early when organizationId cannot be resolved', async () => {
      mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(null);

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: {},
      });

      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
      expect(mockSubscriptionRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('handleSubscriptionUpdated', () => {
    test('should update plan, status, currentPeriodEnd, cancelAtPeriodEnd', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      const periodEnd = Math.floor(Date.now() / 1000) + 86400;

      await WebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: periodEnd,
          cancel_at_period_end: true,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        { data: {} },
      );

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: subId,
          plan: 'pro',
          status: 'active',
          currentPeriodEnd: new Date(periodEnd * 1000),
          cancelAtPeriodEnd: true,
        }),
      );
      expect(mockOrganizationModel.findByIdAndUpdate).toHaveBeenCalledWith(
        orgId, { plan: 'pro' }, { runValidators: true },
      );
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      await WebhookService.handleSubscriptionUpdated(
        { id: 'sub_unknown', items: { data: [] } },
        { data: {} },
      );

      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });

    test('should fall back to free when plan metadata is invalid', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await WebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: 1700000000,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'prod_INVALID' } } }] },
        },
        { data: {} },
      );

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'free' }),
      );
    });
  });

  describe('handleSubscriptionDeleted', () => {
    test('should reset plan to free and status to canceled', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await WebhookService.handleSubscriptionDeleted({ id: 'sub_456' });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ _id: subId, plan: 'free', status: 'canceled' }),
      );
      expect(mockOrganizationModel.findByIdAndUpdate).toHaveBeenCalledWith(
        orgId, { plan: 'free' }, { runValidators: true },
      );
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      await WebhookService.handleSubscriptionDeleted({ id: 'sub_unknown' });

      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('handleInvoicePaymentFailed', () => {
    test('should set status to past_due', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await WebhookService.handleInvoicePaymentFailed({ subscription: 'sub_456' });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ _id: subId, status: 'past_due' }),
      );
    });

    test('should return early when no subscription ID in invoice', async () => {
      await WebhookService.handleInvoicePaymentFailed({ subscription: null });

      expect(mockSubscriptionRepository.findByStripeSubscriptionId).not.toHaveBeenCalled();
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      await WebhookService.handleInvoicePaymentFailed({ subscription: 'sub_unknown' });

      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });
  });
});
