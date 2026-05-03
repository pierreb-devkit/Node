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
   * Build a stub Stripe charge object for charge.refunded webhook tests.
   * @param {Object} [overrides={}] - Fields to override on the stub charge object.
   * @returns {Object} A stub Stripe charge object with refund data set.
   */
  const makeCharge = (overrides = {}) => ({
    id: 'ch_test_001',
    amount: 4900,
    amount_refunded: 4900,
    refunds: { data: [{ id: 'rf_test_001', amount: 4900, created: 1770000000 }] },
    metadata: {
      organizationId: orgId,
      stripeSessionId,
      packId: 'pack_500k',
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
      default: {
        wasProcessed: jest.fn().mockResolvedValue(false),
        tryRecord: jest.fn().mockResolvedValue({ recorded: true }),
      },
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
    test('full refund — calls refundPartial with correct orgId, sessionId, amount, packId and refundId', async () => {
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({ refunds: { data: [{ id: 'rf_001', amount: 4900, created: 1000 }] } }),
      );

      expect(mockExtraService.refundPartial).toHaveBeenCalledTimes(1);
      expect(mockExtraService.refundPartial).toHaveBeenCalledWith(orgId, stripeSessionId, 4900, 'pack_500k', 'rf_001');
    });

    test('two partial refunds in list — calls refundPartial once per entry with its own refund id', async () => {
      // Both refunds are processed; rf_ ids make each call idempotent on replay
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({
          refunds: {
            data: [
              { id: 'rf_first', amount: 2450, created: 1000 },
              { id: 'rf_second', amount: 2450, created: 2000 },
            ],
          },
        }),
      );

      expect(mockExtraService.refundPartial).toHaveBeenCalledTimes(2);
      expect(mockExtraService.refundPartial).toHaveBeenCalledWith(orgId, stripeSessionId, 2450, 'pack_500k', 'rf_first');
      expect(mockExtraService.refundPartial).toHaveBeenCalledWith(orgId, stripeSessionId, 2450, 'pack_500k', 'rf_second');
    });

    test('skips individual refund entries that have no id or zero amount', async () => {
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({
          refunds: {
            data: [
              { amount: 4900, created: 1000 }, // missing id → skipped
              { id: 'rf_valid', amount: 2450, created: 2000 }, // valid → processed
              { id: 'rf_zero', amount: 0, created: 3000 }, // zero amount → skipped
            ],
          },
        }),
      );

      expect(mockExtraService.refundPartial).toHaveBeenCalledTimes(1);
      expect(mockExtraService.refundPartial).toHaveBeenCalledWith(orgId, stripeSessionId, 2450, 'pack_500k', 'rf_valid');
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

    /**
     * MEDIUM 4: explicit verification of the silent skip on missing stripeSessionId.
     * Documents the upstream contract: charge.metadata.stripeSessionId is only present
     * when the upstream session creation sets payment_intent_data.metadata explicitly.
     * Without it, refunds silently skip — no service call, no error logged.
     */
    test('skips silently when charge.metadata lacks stripeSessionId (upstream contract)', async () => {
      // Simulate a charge where payment_intent_data.metadata was NOT set at session creation
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({ metadata: { organizationId: orgId } }), // stripeSessionId absent
      );

      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });

    test('should skip when refunds list is empty', async () => {
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({ refunds: { data: [] } }),
      );

      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });

    test('should skip when refunds list is absent', async () => {
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({ refunds: undefined }),
      );

      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });

    test('should skip when metadata is absent', async () => {
      await BillingWebhookService.handleChargeRefunded(makeCharge({ metadata: undefined }));

      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });
  });
});
