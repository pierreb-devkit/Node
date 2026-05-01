/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.weeklyReset cron script logic.
 *
 * The script itself is a top-level-await CLI entry point that connects to MongoDB and exits.
 * We test the underlying BillingResetService.resetAllDue integration path rather than the
 * script file directly (which would require a live DB connection).
 */
describe('billing.weeklyReset cron — BillingResetService.resetAllDue:', () => {
  let BillingResetService;
  let mockConfig;
  let mockUsageRepository;
  let mockSubscriptionRepository;
  let mockPlanService;

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: true,
        plans: ['pro'],
      },
    };

    mockUsageRepository = {
      findByWeek: jest.fn().mockResolvedValue(null),
      archiveOtherWeeks: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      upsertWeekSnapshot: jest.fn(),
    };

    mockPlanService = {
      getActivePlan: jest.fn().mockResolvedValue({ planId: 'pro', version: 'v1', meterQuota: 500000 }),
    };

    mockSubscriptionRepository = {
      findAllDueForReset: jest.fn(),
      findAllDueForResetByLastReset: jest.fn(),
      findByOrganization: jest.fn().mockResolvedValue({ plan: 'pro' }),
      findPlan: jest.fn().mockResolvedValue({ plan: 'pro' }),
      updateLastResetAt: jest.fn().mockResolvedValue(undefined),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../repositories/billing.usage.repository.js', () => ({
      default: mockUsageRepository,
    }));
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));
    jest.unstable_mockModule('../services/billing.plan.service.js', () => ({
      default: mockPlanService,
    }));

    const mod = await import('../services/billing.reset.service.js');
    BillingResetService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('resetAllDue returns { processed: 0, errors: 0 } when meterMode is false', async () => {
    mockConfig.billing.meterMode = false;

    const result = await BillingResetService.resetAllDue();

    expect(result).toEqual({ processed: 0, errors: 0 });
    expect(mockSubscriptionRepository.findAllDueForResetByLastReset).not.toHaveBeenCalled();
  });

  test('resetAllDue returns { processed: 0, errors: 0 } when no subscriptions are due', async () => {
    mockSubscriptionRepository.findAllDueForResetByLastReset.mockResolvedValue([]);

    const result = await BillingResetService.resetAllDue();

    expect(result).toEqual({ processed: 0, errors: 0 });
  });

  test('resetAllDue processes each due subscription and returns correct count', async () => {
    const subs = [
      { organization: '507f1f77bcf86cd799439011', currentPeriodStart: new Date() },
      { organization: '507f1f77bcf86cd799439022', currentPeriodStart: new Date() },
    ];
    mockSubscriptionRepository.findAllDueForResetByLastReset.mockResolvedValue(subs);
    mockUsageRepository.upsertWeekSnapshot.mockResolvedValue({ weekKey: '2026-W18' });

    const result = await BillingResetService.resetAllDue();

    expect(result.processed).toBe(2);
    expect(result.errors).toBe(0);
  });

  test('resetAllDue counts errors and continues on individual failure', async () => {
    const subs = [
      { organization: '507f1f77bcf86cd799439011', currentPeriodStart: new Date() },
      { organization: '507f1f77bcf86cd799439022', currentPeriodStart: new Date() },
    ];
    mockSubscriptionRepository.findAllDueForResetByLastReset.mockResolvedValue(subs);
    // First call throws, second succeeds
    mockUsageRepository.upsertWeekSnapshot
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce({ weekKey: '2026-W18' });

    const result = await BillingResetService.resetAllDue();

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(1);
  });

  test('resetAllDue is idempotent — no double-upsert when week doc already exists', async () => {
    const subs = [{ organization: '507f1f77bcf86cd799439011', currentPeriodStart: new Date() }];
    mockSubscriptionRepository.findAllDueForResetByLastReset.mockResolvedValue(subs);
    // findByWeek returns existing doc → resetWeek returns early without upsert
    mockUsageRepository.findByWeek.mockResolvedValue({ weekKey: '2026-W18', meterUsed: 100 });

    const result = await BillingResetService.resetAllDue();

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
    expect(mockUsageRepository.upsertWeekSnapshot).not.toHaveBeenCalled();
  });
});
