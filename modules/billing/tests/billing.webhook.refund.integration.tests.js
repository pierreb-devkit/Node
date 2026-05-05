/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Integration tests for handleChargeRefunded webhook handler
 * Covers:
 *   - Normal path: stripeSessionId present in charge metadata
 *   - C1: SENTINEL_PENDING ('__pending__') in charge metadata triggers PI backfill
 *   - C1: Missing stripeSessionId triggers PI backfill
 *   - C1: PI backfill succeeds → refundPartial called with real session ID
 *   - C1: PI backfill returns sentinel too → unresolved alert, refundPartial NOT called
 *   - C1: PI fetch fails → unresolved alert, refundPartial NOT called
 *   - No paymentIntent → unresolved alert immediately
 */
describe('Billing webhook refund integration tests:', () => {
  let BillingWebhookService;
  let mockExtraService;
  let mockSubscriptionRepository;
  let mockStripeInstance;
  let mockGetStripe;
  let mockLogger;
  let mockEvents;

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
    payment_intent: 'pi_test_001',
    refunds: { data: [{ id: 'rf_test_001', amount: 4900, created: Math.floor(Date.now() / 1000) }] },
    metadata: {
      organizationId: orgId,
      stripeSessionId,
      packId: 'pack_500k',
    },
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    mockEvents = { emit: jest.fn() };

    mockExtraService = {
      creditPack: jest.fn(),
      refundPartial: jest.fn().mockResolvedValue({ doc: {}, applied: true, refundUnits: 500000 }),
    };

    mockStripeInstance = {
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'pi_test_001',
          metadata: { stripeSessionId, organizationId: orgId, packId: 'pack_500k', kind: 'extras' },
        }),
      },
    };
    mockGetStripe = jest.fn().mockReturnValue(mockStripeInstance);

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      findByStripeCustomerId: jest.fn(),
      findByStripeSubscriptionId: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateIfEventNewer: jest.fn().mockResolvedValue(null),
    };

    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: mockGetStripe }));

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
      default: mockEvents,
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

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: mockLogger,
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleChargeRefunded — normal path', () => {
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

  // ─────────────────────────────────────────────────────────────────────────────
  // C1 — Sentinel '__pending__' handling
  // ─────────────────────────────────────────────────────────────────────────────
  describe('handleChargeRefunded — C1 sentinel + PI backfill resolver', () => {
    test('C1: stripeSessionId === __pending__ triggers PI backfill, finds real session id, calls refundPartial', async () => {
      // Charge metadata has sentinel — this is the production failure path
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({
          metadata: { organizationId: orgId, stripeSessionId: '__pending__', packId: 'pack_500k' },
          refunds: { data: [{ id: 'rf_sentinel_001', amount: 4900, created: 1000 }] },
        }),
      );

      // PI fetch must have been triggered (sentinel is unresolved)
      expect(mockStripeInstance.paymentIntents.retrieve).toHaveBeenCalledWith('pi_test_001');
      // After backfill, refundPartial must be called with the REAL session id
      expect(mockExtraService.refundPartial).toHaveBeenCalledWith(
        orgId, stripeSessionId, 4900, 'pack_500k', 'rf_sentinel_001',
      );
    });

    test('C1: stripeSessionId absent triggers PI backfill (absent ≡ unresolved)', async () => {
      const charge = makeCharge();
      delete charge.metadata.stripeSessionId;

      await BillingWebhookService.handleChargeRefunded(charge);

      expect(mockStripeInstance.paymentIntents.retrieve).toHaveBeenCalledWith('pi_test_001');
      expect(mockExtraService.refundPartial).toHaveBeenCalledWith(
        orgId, stripeSessionId, 4900, 'pack_500k', 'rf_test_001',
      );
    });

    test('C1: PI backfill returns __pending__ too → emits billing.refund.unresolved, refundPartial NOT called', async () => {
      // Simulates case where the PI metadata patch never ran (checkout.session.completed not processed yet)
      mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_test_001',
        metadata: { stripeSessionId: '__pending__', organizationId: orgId, packId: 'pack_500k' },
      });

      await BillingWebhookService.handleChargeRefunded(
        makeCharge({
          metadata: { organizationId: orgId, stripeSessionId: '__pending__', packId: 'pack_500k' },
          refunds: { data: [{ id: 'rf_still_sentinel', amount: 4900, created: 1000 }] },
        }),
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing] refund unresolved — manual reconciliation required',
        expect.objectContaining({ chargeId: 'ch_test_001' }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'billing.refund.unresolved',
        expect.objectContaining({ chargeId: 'ch_test_001' }),
      );
      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });

    test('C1: PI fetch failure → unresolved alert emitted, refundPartial NOT called', async () => {
      mockStripeInstance.paymentIntents.retrieve.mockRejectedValue(new Error('Stripe API down'));

      await BillingWebhookService.handleChargeRefunded(
        makeCharge({
          metadata: { organizationId: orgId, stripeSessionId: '__pending__', packId: 'pack_500k' },
          refunds: { data: [{ id: 'rf_pi_fail', amount: 4900, created: 1000 }] },
        }),
      );

      // PI fetch error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing] refund PI fetch failed',
        expect.objectContaining({ chargeId: 'ch_test_001' }),
      );
      // After fetch failure → still unresolved → unresolved alert
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing] refund unresolved — manual reconciliation required',
        expect.objectContaining({ chargeId: 'ch_test_001' }),
      );
      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });

    test('C1: no payment_intent on charge AND __pending__ sentinel → unresolved alert without PI fetch', async () => {
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({
          payment_intent: null,
          metadata: { organizationId: orgId, stripeSessionId: '__pending__', packId: 'pack_500k' },
          refunds: { data: [{ id: 'rf_no_pi', amount: 4900, created: 1000 }] },
        }),
      );

      expect(mockStripeInstance.paymentIntents.retrieve).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing] refund unresolved — manual reconciliation required',
        expect.objectContaining({ chargeId: 'ch_test_001' }),
      );
      expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    });

    test('C1: real session id present (not sentinel) → no PI fetch, refundPartial called directly', async () => {
      await BillingWebhookService.handleChargeRefunded(
        makeCharge({ refunds: { data: [{ id: 'rf_normal', amount: 4900, created: 1000 }] } }),
      );

      expect(mockStripeInstance.paymentIntents.retrieve).not.toHaveBeenCalled();
      expect(mockExtraService.refundPartial).toHaveBeenCalledWith(
        orgId, stripeSessionId, 4900, 'pack_500k', 'rf_normal',
      );
    });
  });
});
