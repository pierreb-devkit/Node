/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Integration tests for handleChargeRefunded webhook handler
 */
describe('Billing webhook refund integration tests:', () => {
  let BillingWebhookService;
  let mockExtraService;
  let mockSubscriptionRepository;

  const orgId = '507f1f77bcf86cd799439011';
  const stripeSessionId = 'cs_test_session_abc';

  /**
   * @param {Object} [overrides={}] - Fields to override on the stub charge object.
   * @returns {Object} A stub Stripe charge object.
   */
  const makeCharge = (overrides = {}) => ({
    id: 'ch_test_001',
    amount: 4900,
    amount_refunded: 4900,
    metadata: {
      organizationId: orgId,
      stripeSessionId,
    },
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockExtraService = {
      creditPack: jest.fn(),
      refundPartial: jest.fn().mockResolvedValue({ doc: {}, applied: true, refundUnits: 500000 }),
    };

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      findByStripeCustomerId: jest.fn(),
      findByStripeSubscriptionId: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: mockExtraService,
    }));

    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({
      default: { resetWeek: jest.fn() },
    }));

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: { tryRecord: jest.fn().mockResolvedValue({ recorded: true }) },
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
        model: () => ({ findByIdAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn() }) }),
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleChargeRefunded', () => {
    test('full refund — calls refundPartial with correct orgId, sessionId and amount', async () => {
      await BillingWebhookService.handleChargeRefunded(makeCharge({ amount_refunded: 4900 }));

      expect(mockExtraService.refundPartial).toHaveBeenCalledWith(orgId, stripeSessionId, 4900);
    });

    test('partial refund — calls refundPartial with partial amount', async () => {
      await BillingWebhookService.handleChargeRefunded(makeCharge({ amount_refunded: 2450 }));

      expect(mockExtraService.refundPartial).toHaveBeenCalledWith(orgId, stripeSessionId, 2450);
    });

    test('should skip when organizationId is missing', async () => {
      const charge = makeCharge();
      delete charge.metadata.organizationId;

      await BillingWebhookService.handleChargeRefunded(charge);

      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });

    test('should skip when organizationId is invalid ObjectId', async () => {
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({ metadata: { organizationId: 'not-an-id', stripeSessionId } }),
      );

      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });

    test('should skip when stripeSessionId is missing', async () => {
      const charge = makeCharge();
      delete charge.metadata.stripeSessionId;

      await BillingWebhookService.handleChargeRefunded(charge);

      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });

    test('should skip when amount_refunded is zero', async () => {
      await BillingWebhookService.handleChargeRefunded(makeCharge({ amount_refunded: 0 }));

      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });

    test('should skip when metadata is absent', async () => {
      await BillingWebhookService.handleChargeRefunded(makeCharge({ metadata: undefined }));

      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });
  });
});
