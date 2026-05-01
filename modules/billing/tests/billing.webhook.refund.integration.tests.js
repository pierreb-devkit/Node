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
   * @returns {Object} A stub Stripe charge object with refunds.data[0].amount set.
   */
  const makeCharge = (overrides = {}) => ({
    id: 'ch_test_001',
    amount: 4900,
    amount_refunded: 4900,
    // charge.refunds.data[0].amount = this event's refund delta (not cumulative)
    refunds: { data: [{ id: 'rf_test_001', amount: 4900 }] },
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
    test('full refund — calls refundPartial with correct orgId, sessionId, delta amount and packId', async () => {
      // refunds.data[0].amount = 4900 (this event's delta, same as total for single refund)
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({ refunds: { data: [{ id: 'rf_001', amount: 4900 }] } }),
      );

      expect(mockExtraService.refundPartial).toHaveBeenCalledWith(orgId, stripeSessionId, 4900, 'pack_500k');
    });

    test('partial refund — calls refundPartial with delta amount (not cumulative total)', async () => {
      // Simulates 2nd of two 2450¢ partial refunds: amount_refunded=4900 (cumulative) but
      // refunds.data[0].amount=2450 (this event's delta) — handler must use delta to avoid over-debit
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({
          amount_refunded: 4900, // cumulative — should NOT be used
          refunds: { data: [{ id: 'rf_002', amount: 2450 }] }, // delta — correct value
        }),
      );

      expect(mockExtraService.refundPartial).toHaveBeenCalledWith(orgId, stripeSessionId, 2450, 'pack_500k');
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

    test('should skip when refunds.data[0].amount is absent or zero', async () => {
      // refunds.data empty — no delta available
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
