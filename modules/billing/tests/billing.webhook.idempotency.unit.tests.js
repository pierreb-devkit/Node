/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for webhook idempotency (withIdempotency guard)
 *
 * Contract (post dead-letter-reachability fix):
 * - tryRecord is called BEFORE the handler (atomic claim via unique index).
 * - tryRecord uses 3-state semantics so attempts persists across Stripe redeliveries:
 *     - First delivery        → { recorded: true,  retry: false }              → handler runs
 *     - In-flight retry       → { recorded: true,  retry: true }               → handler runs again
 *     - Already processed     → { recorded: false, reason: 'already_processed' } → skip
 *     - Dead-lettered         → { recorded: false, reason: 'dead_letter' }      → skip
 * - Handler throws → incrementAttempts; if attempts < MAX → throw (Stripe retries),
 *   doc is NOT deleted (attempts persists). At MAX → markDeadLetter + return success sentinel.
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
      incrementAttempts: jest.fn().mockResolvedValue({ attempts: 1 }),
      markDeadLetter: jest.fn().mockResolvedValue({}),
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
        updateIfEventNewer: jest.fn().mockResolvedValue(null),
      },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
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
    test('new event: tryRecord={recorded:true,retry:false} → handler runs → result returned', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true, retry: false });
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
     * In-flight retry: previous run failed, attempts persisted on disk.
     * tryRecord returns { recorded: true, retry: true } → handler runs again.
     */
    test('in-flight retry: tryRecord={recorded:true,retry:true} → handler re-enters', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true, retry: true });
      const handler = jest.fn().mockResolvedValue({ ok: true });
      const event = makeEvent('evt_retry_001');

      const result = await BillingWebhookService.withIdempotency(event, handler);

      expect(handler).toHaveBeenCalledWith(event);
      expect(result).toEqual({ ok: true });
    });

    /**
     * Stripe redelivery after success: tryRecord returns { recorded: false, reason: 'already_processed' }
     * → handler not invoked → skip sentinel returned with detail.
     */
    test('Stripe redelivery after success: skip with detail=already_processed', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: false, reason: 'already_processed' });
      const handler = jest.fn();
      const event = makeEvent();

      const result = await BillingWebhookService.withIdempotency(event, handler);

      expect(handler).not.toHaveBeenCalled();
      expect(result).toEqual({ skipped: true, reason: 'duplicate_event_or_dead_letter', detail: 'already_processed' });
    });

    /**
     * Stripe redelivery after dead-letter: skip and return success sentinel so Stripe stops retrying.
     */
    test('Stripe redelivery after dead-letter: skip with detail=dead_letter', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: false, reason: 'dead_letter' });
      const handler = jest.fn();
      const event = makeEvent('evt_dl_replay');

      const result = await BillingWebhookService.withIdempotency(event, handler);

      expect(handler).not.toHaveBeenCalled();
      expect(result).toEqual({ skipped: true, reason: 'duplicate_event_or_dead_letter', detail: 'dead_letter' });
    });

    /**
     * Concurrent delivery: two simultaneous Stripe deliveries — tryRecord is atomic.
     * First call wins (recorded: true) → handler runs once.
     * Second call loses (recorded: false, already_processed) → handler not run → skip.
     */
    test('concurrent delivery: only the first claim runs the handler (TOCTOU fix)', async () => {
      mockProcessedStripeEventRepository.tryRecord
        .mockResolvedValueOnce({ recorded: true, retry: false }) // first delivery wins
        .mockResolvedValueOnce({ recorded: false, reason: 'already_processed' }); // second loses
      const handler = jest.fn().mockResolvedValue(undefined);
      const event = makeEvent('evt_concurrent', 'customer.subscription.updated');

      const results = await Promise.all([
        BillingWebhookService.withIdempotency(event, handler),
        BillingWebhookService.withIdempotency(event, handler),
      ]);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledTimes(2);
      expect(results.some((r) => r && r.skipped)).toBe(true);
    });

    /**
     * Handler throws below MAX_ATTEMPTS → incrementAttempts called → error re-thrown
     * → doc NOT deleted (attempts must persist across Stripe redeliveries for dead-letter to work).
     */
    test('handler throws (attempts<MAX): incrementAttempts called, doc kept, error re-thrown', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true, retry: false });
      mockProcessedStripeEventRepository.incrementAttempts.mockResolvedValue({ attempts: 1 });
      const handler = jest.fn().mockRejectedValue(new Error('handler blew up'));
      const event = makeEvent();

      await expect(
        BillingWebhookService.withIdempotency(event, handler),
      ).rejects.toThrow('handler blew up');

      expect(mockProcessedStripeEventRepository.incrementAttempts).toHaveBeenCalledWith(
        'evt_test_001',
        'handler blew up',
      );
      // Critical: doc must NOT be deleted — attempts must persist across redeliveries.
      expect(mockProcessedStripeEventRepository.deleteByEventId).not.toHaveBeenCalled();
    });

    /**
     * Retry across redeliveries: handler fails on delivery #1, succeeds on delivery #2.
     * Doc persists between deliveries; tryRecord returns { recorded: true, retry: true } on #2.
     */
    test('retry across redeliveries: second delivery succeeds without rollback', async () => {
      mockProcessedStripeEventRepository.tryRecord
        .mockResolvedValueOnce({ recorded: true, retry: false })
        .mockResolvedValueOnce({ recorded: true, retry: true });
      mockProcessedStripeEventRepository.incrementAttempts.mockResolvedValue({ attempts: 1 });

      const handler = jest.fn()
        .mockRejectedValueOnce(new Error('transient failure'))
        .mockResolvedValueOnce({ ok: true });

      const event = makeEvent('evt_retry_test');

      // First delivery fails — attempts persists, no rollback.
      await expect(
        BillingWebhookService.withIdempotency(event, handler),
      ).rejects.toThrow('transient failure');
      expect(mockProcessedStripeEventRepository.deleteByEventId).not.toHaveBeenCalled();

      // Second delivery (Stripe retry) succeeds via retry: true re-entry.
      const result = await BillingWebhookService.withIdempotency(event, handler);
      expect(result).toEqual({ ok: true });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    /**
     * tryRecord called exactly once per withIdempotency invocation.
     * wasProcessed must NOT be called (old contract removed).
     */
    test('tryRecord called exactly once; wasProcessed never called', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true, retry: false });
      const handler = jest.fn().mockResolvedValue(undefined);
      const event = makeEvent('evt_single_check');

      await BillingWebhookService.withIdempotency(event, handler);

      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledTimes(1);
      expect(mockProcessedStripeEventRepository.wasProcessed).not.toHaveBeenCalled();
    });
  });
});
