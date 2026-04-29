/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for checkout webhook handlers:
 *   - handleCheckoutSessionCompleted routing (subscription vs payment mode)
 *   - handleCheckoutPaymentCompleted (extras pack credit)
 *   - handleCheckoutCompleted (subscription creation/update)
 */
describe('Billing webhook checkout unit tests:', () => {
  let BillingWebhookService;
  let mockSubscriptionRepository;
  let mockOrganizationModel;
  let mockExtraService;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';
  const stripeSessionId = 'cs_test_session_abc';

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

    mockExtraService = {
      creditPack: jest.fn().mockResolvedValue({ doc: {}, applied: true }),
      refundPartial: jest.fn(),
    };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: { tryRecord: jest.fn().mockResolvedValue({ recorded: true }) },
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: mockExtraService,
    }));

    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({
      default: { resetWeek: jest.fn() },
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn() },
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: { plans: ['free', 'starter', 'pro', 'enterprise'] },
      },
    }));

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: (name) => {
          if (name === 'Organization') return mockOrganizationModel;
          return {};
        },
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleCheckoutSessionCompleted routing', () => {
    test('mode=subscription routes to handleCheckoutCompleted (subscription update)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await BillingWebhookService.handleCheckoutSessionCompleted({
        data: {
          object: {
            id: stripeSessionId,
            mode: 'subscription',
            customer: 'cus_123',
            subscription: 'sub_456',
            metadata: { organizationId: orgId, plan: 'pro' },
          },
        },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'pro', status: 'active' }),
      );
      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });

    test('mode=payment + kind=extras routes to handleCheckoutPaymentCompleted (creditPack)', async () => {
      await BillingWebhookService.handleCheckoutSessionCompleted({
        data: {
          object: {
            id: stripeSessionId,
            mode: 'payment',
            metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'extras' },
          },
        },
      });

      expect(mockExtraService.creditPack).toHaveBeenCalledWith(orgId, 'pack_500k', stripeSessionId);
      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });

    test('mode=payment without metadata skips creditPack', async () => {
      await BillingWebhookService.handleCheckoutSessionCompleted({
        data: {
          object: {
            id: stripeSessionId,
            mode: 'payment',
            metadata: null,
          },
        },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });

    test('mode=payment + kind≠extras skips creditPack', async () => {
      await BillingWebhookService.handleCheckoutSessionCompleted({
        data: {
          object: {
            id: stripeSessionId,
            mode: 'payment',
            metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'donation' },
          },
        },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });
  });

  describe('handleCheckoutPaymentCompleted', () => {
    test('should call creditPack with orgId, packId, sessionId', async () => {
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'extras' },
      });

      expect(mockExtraService.creditPack).toHaveBeenCalledWith(orgId, 'pack_500k', stripeSessionId);
    });

    test('should skip when kind is not extras', async () => {
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'other' },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });

    test('should skip when organizationId is invalid ObjectId', async () => {
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        metadata: { organizationId: 'not-valid', packId: 'pack_500k', kind: 'extras' },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });

    test('should skip when packId is missing', async () => {
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        metadata: { organizationId: orgId, kind: 'extras' },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });

    test('should skip when organizationId is missing', async () => {
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        metadata: { packId: 'pack_500k', kind: 'extras' },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });
  });

  describe('handleCheckoutCompleted (mode=subscription)', () => {
    test('should update existing subscription', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await BillingWebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId, plan: 'pro' },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ _id: subId, plan: 'pro', status: 'active' }),
      );
    });

    test('should create subscription when none exists', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockSubscriptionRepository.create.mockResolvedValue({});

      await BillingWebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId, plan: 'starter' },
      });

      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organization: orgId,
          plan: 'starter',
          status: 'active',
        }),
      );
    });
  });
});
