/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for webhook idempotency (withIdempotency guard)
 */
describe('Billing webhook idempotency unit tests:', () => {
  let BillingWebhookService;
  let mockProcessedStripeEventRepository;

  const makeEvent = (id = 'evt_test_001', type = 'checkout.session.completed') => ({
    id,
    type,
    data: { object: { id: 'obj_1' } },
  });

  beforeEach(async () => {
    jest.resetModules();

    mockProcessedStripeEventRepository = {
      wasProcessed: jest.fn(),
      tryRecord: jest.fn(),
    };

    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: mockProcessedStripeEventRepository,
    }));

    // Minimal mocks so the service module loads without errors
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {
        findByOrganization: jest.fn(),
        findByStripeCustomerId: jest.fn(),
        findByStripeSubscriptionId: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: { creditPack: jest.fn(), refundPartial: jest.fn() },
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
        model: () => ({ findByIdAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn() }) }),
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('withIdempotency', () => {
    test('should call handler when event is new (wasProcessed=false), then record', async () => {
      mockProcessedStripeEventRepository.wasProcessed.mockResolvedValue(false);
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true });
      const handler = jest.fn().mockResolvedValue({ ok: true });
      const event = makeEvent();

      const result = await BillingWebhookService.withIdempotency(event, handler);

      expect(mockProcessedStripeEventRepository.wasProcessed).toHaveBeenCalledWith('evt_test_001');
      expect(handler).toHaveBeenCalledWith(event);
      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledWith('evt_test_001', 'checkout.session.completed');
      expect(result).toEqual({ ok: true });
    });

    /**
     * Stripe retry after success: wasProcessed returns true → handler not run.
     * This is the primary dedup path for Stripe event retries after successful processing.
     */
    test('Stripe retry after success: wasProcessed=true → handler not run', async () => {
      mockProcessedStripeEventRepository.wasProcessed.mockResolvedValue(true);
      const handler = jest.fn();
      const event = makeEvent();

      const result = await BillingWebhookService.withIdempotency(event, handler);

      expect(mockProcessedStripeEventRepository.wasProcessed).toHaveBeenCalledWith('evt_test_001');
      expect(handler).not.toHaveBeenCalled();
      expect(mockProcessedStripeEventRepository.tryRecord).not.toHaveBeenCalled();
      expect(result).toEqual({ skipped: true, reason: 'duplicate_event' });
    });

    /**
     * Concurrent delivery: two simultaneous Stripe deliveries of the same event both pass
     * wasProcessed (it's not atomic). Both handlers run (acceptable per data-layer idempotency).
     * Only the first tryRecord succeeds; the second gets E11000 → recorded=false (best-effort).
     */
    test('concurrent delivery: both pass wasProcessed, both run handler, second tryRecord gets E11000', async () => {
      mockProcessedStripeEventRepository.wasProcessed.mockResolvedValue(false);
      mockProcessedStripeEventRepository.tryRecord
        .mockResolvedValueOnce({ recorded: true })
        .mockResolvedValueOnce({ recorded: false }); // E11000 on the second concurrent delivery

      const handler = jest.fn().mockResolvedValue(undefined);
      const event = makeEvent('evt_concurrent', 'customer.subscription.updated');

      // Both deliveries run concurrently — both pass wasProcessed
      await Promise.all([
        BillingWebhookService.withIdempotency(event, handler),
        BillingWebhookService.withIdempotency(event, handler),
      ]);

      // Both handlers ran (acceptable — data-layer mutations are idempotent)
      expect(handler).toHaveBeenCalledTimes(2);
      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledTimes(2);
    });

    /**
     * Silent-loss fix proof: if handler throws, no record is persisted.
     * Stripe will retry; the handler gets another chance → no silent event loss.
     */
    test('handler throws → no record persisted (silent-loss fix)', async () => {
      mockProcessedStripeEventRepository.wasProcessed.mockResolvedValue(false);
      const handler = jest.fn().mockRejectedValue(new Error('handler blew up'));
      const event = makeEvent();

      await expect(
        BillingWebhookService.withIdempotency(event, handler),
      ).rejects.toThrow('handler blew up');

      // tryRecord must NOT have been called — event stays unprocessed for Stripe to retry
      expect(mockProcessedStripeEventRepository.tryRecord).not.toHaveBeenCalled();
    });

    test('wasProcessed called exactly once per withIdempotency invocation', async () => {
      mockProcessedStripeEventRepository.wasProcessed.mockResolvedValue(false);
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true });
      const handler = jest.fn().mockResolvedValue(undefined);
      const event = makeEvent('evt_single_check');

      await BillingWebhookService.withIdempotency(event, handler);

      expect(mockProcessedStripeEventRepository.wasProcessed).toHaveBeenCalledTimes(1);
      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledTimes(1);
    });
  });
});
