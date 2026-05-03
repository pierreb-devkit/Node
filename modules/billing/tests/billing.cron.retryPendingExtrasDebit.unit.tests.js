/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for retry-pending-extras-debit cron logic.
 */
describe('billing.retryPendingExtrasDebit cron — BillingMeterOutboxService:', () => {
  let BillingMeterOutboxService;
  let mockOutboxRepository;
  let mockExtraService;
  let mockEvents;
  let mockConfig;

  const orgId = '507f1f77bcf86cd799439011';

  /**
   * @param {Object} [overrides={}] - Fields to override on the pending outbox row.
   * @returns {Object} A stub pending outbox row.
   */
  const makeOutbox = (overrides = {}) => ({
    _id: '607f1f77bcf86cd799439099',
    organizationId: orgId,
    idempotencyKey: '507f1f77bcf86cd799439022:initial',
    extrasUnits: 100,
    attempts: 0,
    status: 'pending',
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockOutboxRepository = {
      findPendingDue: jest.fn(),
      markCommitted: jest.fn(),
      markFailedAttempt: jest.fn(),
    };

    mockExtraService = {
      debit: jest.fn(),
    };

    mockEvents = {
      emit: jest.fn(),
    };

    mockConfig = {
      billing: {
        outbox: { maxRetryAttempts: 5 },
        events: { extrasExhausted: 'billing.extras_debit.exhausted' },
      },
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../repositories/billing.meter.outbox.repository.js', () => ({
      default: mockOutboxRepository,
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: mockExtraService,
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: mockEvents,
    }));

    const mod = await import('../services/billing.meter.outbox.service.js');
    BillingMeterOutboxService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('retries a pending row and marks it committed on debit success', async () => {
    const row = makeOutbox();
    mockOutboxRepository.findPendingDue.mockResolvedValue([row]);
    mockExtraService.debit.mockResolvedValue({ applied: true });
    mockOutboxRepository.markCommitted.mockResolvedValue({ modifiedCount: 1 });

    const result = await BillingMeterOutboxService.retryPendingExtrasDebits(300000, 100);

    expect(mockOutboxRepository.findPendingDue).toHaveBeenCalledWith(300000, 100);
    expect(mockExtraService.debit).toHaveBeenCalledWith(orgId, 100, row.idempotencyKey);
    expect(mockOutboxRepository.markCommitted).toHaveBeenCalledWith(row._id);
    expect(result).toEqual({ scanned: 1, committed: 1, failedAttempts: 0, exhausted: 0 });
  });

  test('records failed attempts when debit throws', async () => {
    const row = makeOutbox();
    const err = new Error('write failed');
    mockOutboxRepository.findPendingDue.mockResolvedValue([row]);
    mockExtraService.debit.mockRejectedValue(err);
    mockOutboxRepository.markFailedAttempt.mockResolvedValue(makeOutbox({ attempts: 1 }));

    const result = await BillingMeterOutboxService.retryPendingExtrasDebits();

    expect(mockOutboxRepository.markFailedAttempt).toHaveBeenCalledWith(row._id, err);
    expect(mockEvents.emit).not.toHaveBeenCalled();
    expect(result.failedAttempts).toBe(1);
  });

  test('after 5 failures marks failed and emits billing.extras_debit.exhausted', async () => {
    const row = makeOutbox({ attempts: 4 });
    const failed = makeOutbox({
      attempts: 5,
      status: 'failed',
      lastError: 'still failing',
    });
    mockOutboxRepository.findPendingDue.mockResolvedValue([row]);
    mockExtraService.debit.mockResolvedValue({ applied: false });
    mockOutboxRepository.markFailedAttempt.mockResolvedValue(failed);

    const result = await BillingMeterOutboxService.retryPendingExtrasDebits();

    expect(mockOutboxRepository.markFailedAttempt).toHaveBeenCalledWith(row._id, 'extras debit not applied');
    expect(mockEvents.emit).toHaveBeenCalledWith('billing.extras_debit.exhausted', {
      organizationId: orgId,
      idempotencyKey: row.idempotencyKey,
      extrasUnits: 100,
      attempts: 5,
      lastError: 'still failing',
    });
    expect(result).toEqual({ scanned: 1, committed: 0, failedAttempts: 1, exhausted: 1 });
  });

  test('uses configured exhausted event name and max retry attempts', async () => {
    mockConfig.billing.outbox.maxRetryAttempts = 3;
    mockConfig.billing.events.extrasExhausted = 'billing.custom.exhausted';
    const row = makeOutbox({ attempts: 2 });
    const failed = makeOutbox({
      attempts: 3,
      status: 'failed',
      lastError: 'still failing',
    });
    mockOutboxRepository.findPendingDue.mockResolvedValue([row]);
    mockExtraService.debit.mockResolvedValue({ applied: false });
    mockOutboxRepository.markFailedAttempt.mockResolvedValue(failed);

    const result = await BillingMeterOutboxService.retryPendingExtrasDebits();

    expect(mockEvents.emit).toHaveBeenCalledWith('billing.custom.exhausted', expect.objectContaining({
      attempts: 3,
    }));
    expect(result.exhausted).toBe(1);
  });

  test('does not emit exhausted event when failed row is past transition attempt', async () => {
    const row = makeOutbox({ attempts: 5 });
    const failed = makeOutbox({ attempts: 6, status: 'failed' });
    mockOutboxRepository.findPendingDue.mockResolvedValue([row]);
    mockExtraService.debit.mockResolvedValue({ applied: false });
    mockOutboxRepository.markFailedAttempt.mockResolvedValue(failed);

    const result = await BillingMeterOutboxService.retryPendingExtrasDebits();

    expect(mockEvents.emit).not.toHaveBeenCalled();
    expect(result.exhausted).toBe(0);
  });
});
