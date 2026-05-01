/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for webhook idempotency (withIdempotency guard)
 *
 * Contract (post #3573 fix — atomic-claim):
 * - tryRecord is called BEFORE the handler (atomic claim via unique index)
 * - If tryRecord returns { recorded: false } → skip (Stripe retry or concurrent delivery)
 * - If handler throws → deleteByEventId rollback → Stripe can retry
 * - On success → record stays permanently (subsequent Stripe retries skipped)
 */
describe('Billing webhook idempotency unit tests:', () => {
  let BillingWebhookService;
  let mockProcessedStripeEventRepository;

  /**
   * Build a Stripe-like webhook event payload for idempotency tests.
   * @param {string} [id='evt_test_001'] - Stripe event ID.
   * @param {string} [type='checkout.session.completed'] - Stripe event type.
   * @returns {{ id: string, type: string, data: { object: { id: string } } }} Minimal event object.
   */
  const makeEvent = (id = 'evt_test_001', type = 'checkout.session.completed') => ({
    id,
    type,
    data: { object: { id: 'obj_1' } },
  });

  beforeEach(async () => {
    jest.resetModules();

    mockProcessedStripeEventRepository = {
      tryRecord: jest.fn(),
      wasProcessed: jest.fn(),
      deleteByEventId: jest.fn(),
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
    /**
     * Happy path: new event — tryRecord succeeds, handler runs, result returned.
     */
    test('new event: tryRecord=true → handler runs → result returned', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true });
      const handler = jest.fn().mockResolvedValue({ ok: true });
      const event = makeEvent();

      const result = await BillingWebhookService.withIdempotency(event, handler);

      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledWith(
        'evt_test_001',
        'checkout.session.completed',
      );
      expect(handler).toHaveBeenCalledWith(event);
      expect(result).toEqual({ ok: true });
    });

    /**
     * Stripe retry after success: tryRecord returns { recorded: false } (unique index hit)
     * → handler not invoked → skip sentinel returned.
     */
    test('Stripe retry: tryRecord=false → handler not run → skip sentinel', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: false });
      const handler = jest.fn();
      const event = makeEvent();

      const result = await BillingWebhookService.withIdempotency(event, handler);

      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledWith(
        'evt_test_001',
        'checkout.session.completed',
      );
      expect(handler).not.toHaveBeenCalled();
      expect(result).toEqual({ skipped: true, reason: 'duplicate_event' });
    });

    /**
     * Concurrent delivery: two simultaneous Stripe deliveries — tryRecord is atomic.
     * First call wins (recorded: true) → handler runs once.
     * Second call loses (recorded: false) → handler not run → skip.
     *
     * This is the TOCTOU fix: only ONE handler execution vs the old 2-execution race.
     */
    test('concurrent delivery: only the first claim runs the handler (TOCTOU fix)', async () => {
      mockProcessedStripeEventRepository.tryRecord
        .mockResolvedValueOnce({ recorded: true }) // first delivery wins
        .mockResolvedValueOnce({ recorded: false }); // second delivery loses
      const handler = jest.fn().mockResolvedValue(undefined);
      const event = makeEvent('evt_concurrent', 'customer.subscription.updated');

      const results = await Promise.all([
        BillingWebhookService.withIdempotency(event, handler),
        BillingWebhookService.withIdempotency(event, handler),
      ]);

      // Handler runs exactly ONCE (not twice as in the old TOCTOU bug)
      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledTimes(2);
      expect(results.some((r) => r && r.skipped)).toBe(true);
    });

    /**
     * Handler throws → deleteByEventId rollback → event stays unprocessed for Stripe to retry.
     * wasProcessed is NOT called (old pre-check removed in favour of atomic-claim).
     */
    test('handler throws → deleteByEventId called (rollback) → error re-thrown', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true });
      mockProcessedStripeEventRepository.deleteByEventId.mockResolvedValue({ deleted: true });
      const handler = jest.fn().mockRejectedValue(new Error('handler blew up'));
      const event = makeEvent();

      await expect(
        BillingWebhookService.withIdempotency(event, handler),
      ).rejects.toThrow('handler blew up');

      expect(mockProcessedStripeEventRepository.deleteByEventId).toHaveBeenCalledWith('evt_test_001');
    });

    /**
     * Retry after rollback: handler fails (rollback), then Stripe retries.
     * On the second delivery tryRecord succeeds again (record was deleted) → handler runs.
     */
    test('retry after rollback: second delivery succeeds after first handler failure', async () => {
      // First delivery: claim succeeds, handler throws, rollback runs
      mockProcessedStripeEventRepository.tryRecord
        .mockResolvedValueOnce({ recorded: true })
        .mockResolvedValueOnce({ recorded: true }); // second delivery can claim again
      mockProcessedStripeEventRepository.deleteByEventId.mockResolvedValue({ deleted: true });

      const handler = jest.fn()
        .mockRejectedValueOnce(new Error('transient failure'))
        .mockResolvedValueOnce({ ok: true });

      const event = makeEvent('evt_retry_test');

      // First delivery fails
      await expect(
        BillingWebhookService.withIdempotency(event, handler),
      ).rejects.toThrow('transient failure');

      expect(mockProcessedStripeEventRepository.deleteByEventId).toHaveBeenCalledWith('evt_retry_test');

      // Second delivery (Stripe retry) succeeds
      const result = await BillingWebhookService.withIdempotency(event, handler);
      expect(result).toEqual({ ok: true });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    /**
     * tryRecord called exactly once per withIdempotency invocation.
     * wasProcessed must NOT be called (old contract removed).
     */
    test('tryRecord called exactly once; wasProcessed never called', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true });
      const handler = jest.fn().mockResolvedValue(undefined);
      const event = makeEvent('evt_single_check');

      await BillingWebhookService.withIdempotency(event, handler);

      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledTimes(1);
      expect(mockProcessedStripeEventRepository.wasProcessed).not.toHaveBeenCalled();
    });
  });
});
