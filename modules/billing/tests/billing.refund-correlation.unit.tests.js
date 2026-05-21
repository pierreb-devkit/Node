/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests — checkout.session.completed PaymentIntent metadata backfill retry
 *
 * Covers:
 *   - retryWithBackoff: 3 attempts on Stripe API failure before escalating
 *   - Dead-letter: BillingFailedBackfill.create called after 3 consecutive failures
 *   - Dead-letter write failure: logger.error emitted, handler does not throw
 */

describe('checkout.session.completed — metadata backfill retry:', () => {
  let BillingWebhookService;
  let mockStripeInstance;
  let mockExtraService;
  let mockLogger;
  let mockBillingFailedBackfill;

  const orgId = '507f1f77bcf86cd799439011';
  const stripeSessionId = 'cs_test_session_abc';
  const paymentIntentId = 'pi_test_retry_001';

  const makeSession = () => ({
    id: stripeSessionId,
    payment_status: 'paid',
    payment_intent: paymentIntentId,
    metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'extras' },
  });

  beforeEach(async () => {
    jest.resetModules();
    // Use fake timers so backoff delays don't slow the suite.
    jest.useFakeTimers();

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    mockExtraService = {
      creditPack: jest.fn().mockResolvedValue({ doc: {}, applied: true }),
      refundPartial: jest.fn(),
    };

    mockStripeInstance = {
      paymentIntents: {
        update: jest.fn().mockResolvedValue({}),
        retrieve: jest.fn().mockResolvedValue({ id: paymentIntentId, metadata: { stripeSessionId } }),
      },
    };

    // BillingFailedBackfillRepository.record() is the repository boundary used by the service.
    mockBillingFailedBackfill = {
      record: jest.fn().mockResolvedValue({}),
    };

    jest.unstable_mockModule('../lib/stripe.js', () => ({
      default: jest.fn(() => mockStripeInstance),
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: mockExtraService,
    }));

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {
        findByOrganization: jest.fn(),
        findByStripeCustomerId: jest.fn(),
        findByStripeSubscriptionId: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateIfEventNewer: jest.fn().mockResolvedValue(null),
      },
    }));

    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: {
        tryRecord: jest.fn().mockResolvedValue({ recorded: true }),
        incrementAttempts: jest.fn(),
        markDeadLetter: jest.fn(),
        deleteByEventId: jest.fn(),
      },
    }));

    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: { setPlan: jest.fn().mockResolvedValue({}) },
    }));

    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({
      default: { resetWeek: jest.fn(), forceRotateForPlanChange: jest.fn() },
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn() },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: mockLogger,
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { billing: { plans: ['free', 'starter', 'pro', 'enterprise'] } },
    }));

    jest.unstable_mockModule('../repositories/billing.failedBackfill.repository.js', () => ({
      default: mockBillingFailedBackfill,
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('retries up to 3 times on Stripe API failure before escalating', async () => {
    // Fail twice, succeed on the third attempt.
    mockStripeInstance.paymentIntents.update
      .mockRejectedValueOnce(new Error('Stripe 500'))
      .mockRejectedValueOnce(new Error('Stripe 500'))
      .mockResolvedValueOnce({});

    const promise = BillingWebhookService.handleCheckoutPaymentCompleted(makeSession());

    // Advance fake timers past the two backoff delays (200ms + 400ms).
    await jest.runAllTimersAsync();

    await promise;

    // 3 total calls (2 retries + 1 success)
    expect(mockStripeInstance.paymentIntents.update).toHaveBeenCalledTimes(3);
    // No dead-letter record created because the third attempt succeeded.
    expect(mockBillingFailedBackfill.record).not.toHaveBeenCalled();
    // No error log — outcome was successful.
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('escalates to dead-letter after 3 failed retries', async () => {
    const stripeErr = new Error('Stripe persistently down');
    mockStripeInstance.paymentIntents.update.mockRejectedValue(stripeErr);

    const promise = BillingWebhookService.handleCheckoutPaymentCompleted(makeSession());

    // Advance past all backoff delays.
    await jest.runAllTimersAsync();

    await promise;

    // All 3 attempts exhausted.
    expect(mockStripeInstance.paymentIntents.update).toHaveBeenCalledTimes(3);

    // logger.error should be called for the final failure.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('backfill failed after retries'),
      expect.objectContaining({ paymentIntentId }),
    );

    // Dead-letter record created with the right shape.
    expect(mockBillingFailedBackfill.record).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId,
        stripeSessionId,
        error: stripeErr.message,
      }),
    );
  });

  test('handler does not throw when dead-letter write itself fails', async () => {
    mockStripeInstance.paymentIntents.update.mockRejectedValue(new Error('Stripe down'));
    mockBillingFailedBackfill.record.mockRejectedValue(new Error('Mongo down'));

    const promise = BillingWebhookService.handleCheckoutPaymentCompleted(makeSession());
    await jest.runAllTimersAsync();

    // Must not throw even if both the backfill and dead-letter write fail.
    await expect(promise).resolves.toBeUndefined();

    // Both error paths should be logged.
    expect(mockLogger.error).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('backfill failed after retries'),
      expect.objectContaining({ paymentIntentId }),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('dead-letter write failed'),
      expect.objectContaining({ paymentIntentId }),
    );
  });
});
