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
    test('should call handler when event is new (recorded=true)', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true });
      const handler = jest.fn().mockResolvedValue({ ok: true });
      const event = makeEvent();

      const result = await BillingWebhookService.withIdempotency(event, handler);

      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledWith('evt_test_001', 'checkout.session.completed');
      expect(handler).toHaveBeenCalledWith(event);
      expect(result).toEqual({ ok: true });
    });

    test('should skip handler and return { skipped: true } on duplicate event (recorded=false)', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: false });
      const handler = jest.fn();
      const event = makeEvent();

      const result = await BillingWebhookService.withIdempotency(event, handler);

      expect(handler).not.toHaveBeenCalled();
      expect(result).toEqual({ skipped: true, reason: 'duplicate_event' });
    });

    test('same event delivered twice — handler called exactly once', async () => {
      mockProcessedStripeEventRepository.tryRecord
        .mockResolvedValueOnce({ recorded: true })
        .mockResolvedValueOnce({ recorded: false });

      const handler = jest.fn().mockResolvedValue(undefined);
      const event = makeEvent('evt_double', 'customer.subscription.updated');

      await BillingWebhookService.withIdempotency(event, handler);
      await BillingWebhookService.withIdempotency(event, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledTimes(2);
    });

    test('should propagate errors thrown by handler', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true });
      const handler = jest.fn().mockRejectedValue(new Error('handler blew up'));
      const event = makeEvent();

      await expect(
        BillingWebhookService.withIdempotency(event, handler),
      ).rejects.toThrow('handler blew up');
    });

    test('tryRecord called exactly once per withIdempotency invocation', async () => {
      mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true });
      const handler = jest.fn().mockResolvedValue(undefined);
      const event = makeEvent('evt_single_check');

      await BillingWebhookService.withIdempotency(event, handler);

      expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledTimes(1);
    });
  });
});
