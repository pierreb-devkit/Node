/**
 * Module dependencies.
 */
import { jest, describe, test, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.init — ops alerting listeners.
 *
 * Covers:
 *   - billing.dispute.opened  (priority 5)
 *   - billing.dispute.lost    (priority 5)
 *   - billing.refund.unresolved (priority 4)
 *   - billing.reconciliation.divergence (priority 4)
 *   - billing.webhook.plan_unresolved (priority 4)
 *   - error event listener on billingEvents singleton
 *
 * Each listener must:
 *   1. Call logger.error with the correct message and structured payload.
 *   2. Swallow alert-sink failures without crashing the EventEmitter.
 *   3. Not propagate errors when the logger itself throws.
 */
describe('billing.init ops-listeners unit tests:', () => {
  let billingInit;
  let mockLogger;
  let realBillingEvents;

  const mockApp = {};

  /**
   * Wire minimal mocks for billing.init dependencies, import the module, and
   * run billingInit. Sets `mockLogger` and `realBillingEvents` in the outer
   * scope as side effects so individual tests can emit events and assert on
   * the logger.
   *
   * @param {Object} [options={}] - Setup options.
   * @param {Object} [options.loggerOverrides={}] - Method overrides merged into the mock logger.
   * @returns {Promise<void>}
   */
  const setup = async ({ loggerOverrides = {} } = {}) => {
    jest.resetModules();

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      ...loggerOverrides,
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { billing: { meterMode: false, packs: [] } },
    }));

    jest.unstable_mockModule('../repositories/billing.usage.repository.js', () => ({
      default: { countLegacyConsumedHistoryIds: jest.fn().mockResolvedValue(0) },
    }));

    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { groupIdentify: jest.fn() },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: mockLogger,
    }));

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn().mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) }),
      },
    }));

    // Stub billing.email so ops-listener tests don't wire email listeners
    jest.unstable_mockModule('../billing.email.js', () => ({
      setupBillingEmails: jest.fn(),
    }));

    // Import billing.init first — it registers listeners on the real billingEvents singleton.
    const mod = await import('../billing.init.js');
    billingInit = mod.default;

    // Grab the real singleton (same module instance, not a mock) for emit calls.
    const eventsModule = await import('../lib/events.js');
    realBillingEvents = eventsModule.default;

    // Run init to wire the listeners.
    await billingInit(mockApp);
  };

  afterEach(() => {
    if (realBillingEvents) {
      realBillingEvents.removeAllListeners('billing.dispute.opened');
      realBillingEvents.removeAllListeners('billing.dispute.lost');
      realBillingEvents.removeAllListeners('billing.refund.unresolved');
      realBillingEvents.removeAllListeners('billing.reconciliation.divergence');
      realBillingEvents.removeAllListeners('billing.webhook.plan_unresolved');
      realBillingEvents.removeAllListeners('error');
    }
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // billing.dispute.opened
  // ---------------------------------------------------------------------------
  describe('billing.dispute.opened listener:', () => {
    test('fires logger.error with correct fields on dispute.opened event', async () => {
      await setup();

      const payload = {
        disputeId: 'dp_123',
        chargeId: 'ch_abc',
        organizationId: '507f1f77bcf86cd799439011',
        stripeSessionId: 'cs_live_xyz',
        amount: 4900,
        reason: 'fraudulent',
      };

      realBillingEvents.emit('billing.dispute.opened', payload);

      // Give the async listener a tick to execute.
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing.init] ALERT: dispute opened — 7-day evidence window — manual review required',
        expect.objectContaining({
          disputeId: 'dp_123',
          chargeId: 'ch_abc',
          organizationId: '507f1f77bcf86cd799439011',
          amount: 4900,
          reason: 'fraudulent',
          ntfyPriority: 5,
        }),
      );
    });

    test('dispute.opened: emitting the event does not throw synchronously', async () => {
      await setup();

      const payload = { disputeId: 'dp_ok', chargeId: 'ch_ok', organizationId: 'org', stripeSessionId: 'cs', amount: 100, reason: 'x' };

      // EventEmitter.emit() is sync — async listener rejection must not propagate synchronously.
      expect(() => realBillingEvents.emit('billing.dispute.opened', payload)).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  // ---------------------------------------------------------------------------
  // billing.dispute.lost
  // ---------------------------------------------------------------------------
  describe('billing.dispute.lost listener:', () => {
    test('fires logger.error with correct fields on dispute.lost event', async () => {
      await setup();

      const payload = {
        disputeId: 'dp_456',
        chargeId: 'ch_def',
        organizationId: '507f1f77bcf86cd799439022',
        stripeSessionId: 'cs_live_zzz',
        amount: 9900,
      };

      realBillingEvents.emit('billing.dispute.lost', payload);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing.init] ALERT: dispute lost — funds withdrawn — ledger debited',
        expect.objectContaining({
          disputeId: 'dp_456',
          chargeId: 'ch_def',
          amount: 9900,
          ntfyPriority: 5,
        }),
      );
    });

    test('dispute.lost: emitting the event does not throw synchronously', async () => {
      await setup();

      const payload = { disputeId: 'dp_ok2', chargeId: 'ch_ok2', organizationId: 'org', stripeSessionId: 'cs', amount: 50 };
      expect(() => realBillingEvents.emit('billing.dispute.lost', payload)).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  // ---------------------------------------------------------------------------
  // billing.refund.unresolved
  // ---------------------------------------------------------------------------
  describe('billing.refund.unresolved listener:', () => {
    test('fires logger.error with full payload spread + ntfyPriority 4', async () => {
      await setup();

      const payload = { chargeId: 'ch_ref', paymentIntentId: 'pi_ref', refundAmount: 1500 };

      realBillingEvents.emit('billing.refund.unresolved', payload);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing.init] ALERT: refund unresolved — manual reconciliation required',
        expect.objectContaining({
          chargeId: 'ch_ref',
          paymentIntentId: 'pi_ref',
          refundAmount: 1500,
          ntfyPriority: 4,
        }),
      );
    });

    test('refund.unresolved: emitting the event does not throw synchronously', async () => {
      await setup();

      expect(() => realBillingEvents.emit('billing.refund.unresolved', { chargeId: 'ch_ok3' })).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  // ---------------------------------------------------------------------------
  // billing.reconciliation.divergence
  // ---------------------------------------------------------------------------
  describe('billing.reconciliation.divergence listener:', () => {
    test('fires logger.error with db/stripe divergence fields + ntfyPriority 4', async () => {
      await setup();

      const payload = {
        organizationId: '507f1f77bcf86cd799439033',
        subscriptionId: '507f1f77bcf86cd799439044',
        stripeSubscriptionId: 'sub_live_aaa',
        db: { status: 'active', plan: 'growth' },
        stripe: { status: 'past_due', plan: 'growth' },
        statusMismatch: true,
        planMismatch: false,
      };

      realBillingEvents.emit('billing.reconciliation.divergence', payload);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing.init] ALERT: reconciliation divergence — DB vs Stripe mismatch',
        expect.objectContaining({
          organizationId: '507f1f77bcf86cd799439033',
          statusMismatch: true,
          planMismatch: false,
          ntfyPriority: 4,
        }),
      );
    });

    test('reconciliation.divergence: emitting the event does not throw synchronously', async () => {
      await setup();

      const payload = { organizationId: 'org', subscriptionId: 's1', stripeSubscriptionId: 'sub_x', db: {}, stripe: {}, statusMismatch: true, planMismatch: false };
      expect(() => realBillingEvents.emit('billing.reconciliation.divergence', payload)).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  // ---------------------------------------------------------------------------
  // billing.webhook.plan_unresolved
  // ---------------------------------------------------------------------------
  describe('billing.webhook.plan_unresolved listener:', () => {
    test('fires logger.error with full payload spread + ntfyPriority 4', async () => {
      await setup();

      const payload = {
        organizationId: '507f1f77bcf86cd799439055',
        eventId: 'evt_plan_unresolved',
        stripeSubscriptionId: 'sub_live_bbb',
        priceId: 'price_unmapped',
        retainedPlan: 'growth',
        hadKnownPlan: true,
      };

      realBillingEvents.emit('billing.webhook.plan_unresolved', payload);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing.init] ALERT: webhook plan unresolved — manual review required',
        expect.objectContaining({
          organizationId: '507f1f77bcf86cd799439055',
          eventId: 'evt_plan_unresolved',
          stripeSubscriptionId: 'sub_live_bbb',
          priceId: 'price_unmapped',
          retainedPlan: 'growth',
          hadKnownPlan: true,
          ntfyPriority: 4,
        }),
      );
    });

    test('plan_unresolved: emitting the event does not throw synchronously', async () => {
      await setup();

      const payload = {
        organizationId: 'org',
        eventId: 'evt_ok',
        stripeSubscriptionId: 'sub_ok',
        priceId: 'price_ok',
        retainedPlan: 'free',
        hadKnownPlan: false,
      };
      expect(() => realBillingEvents.emit('billing.webhook.plan_unresolved', payload)).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple listeners all fire (sanity)
  // ---------------------------------------------------------------------------
  test('multiple ops listeners all fire independently on their respective events', async () => {
    await setup();

    realBillingEvents.emit('billing.dispute.opened', { disputeId: 'dp_a', chargeId: 'ch_a', organizationId: 'o', stripeSessionId: 'cs', amount: 100, reason: 'r' });
    realBillingEvents.emit('billing.dispute.lost', { disputeId: 'dp_b', chargeId: 'ch_b', organizationId: 'o', stripeSessionId: 'cs', amount: 200 });
    realBillingEvents.emit('billing.refund.unresolved', { chargeId: 'ch_c' });
    realBillingEvents.emit('billing.reconciliation.divergence', { organizationId: 'o', subscriptionId: 's', stripeSubscriptionId: 'sub_x', db: {}, stripe: {}, statusMismatch: true, planMismatch: false });
    realBillingEvents.emit('billing.webhook.plan_unresolved', { organizationId: 'o', eventId: 'evt_d', stripeSubscriptionId: 'sub_y', priceId: 'price_y', retainedPlan: 'free', hadKnownPlan: false });

    await new Promise((resolve) => setImmediate(resolve));

    // 5 listeners, 1 logger.error call each = 5 total
    expect(mockLogger.error).toHaveBeenCalledTimes(5);
  });

  // ---------------------------------------------------------------------------
  // error event listener on billingEvents singleton
  // ---------------------------------------------------------------------------
  describe('billingEvents error listener (events.js):', () => {
    test('emitting error event calls logger.error and does not crash', async () => {
      await setup();

      const err = new Error('unexpected emitter error');

      // Without the listener this would throw; with it, it must not.
      expect(() => realBillingEvents.emit('error', err)).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billingEvents] uncaught error event',
        expect.objectContaining({ err }),
      );
    });
  });
});
