/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.reset.service.js
 */
describe('BillingResetService unit tests:', () => {
  let BillingResetService;
  let mockUsageRepository;
  let mockPlanService;
  let mockConfig;
  let mockMongooseUsage;
  let mockMongooseSubscription;

  const orgId = '507f1f77bcf86cd799439011';

  const makePlan = (overrides = {}) => ({
    planId: 'pro',
    version: 'v1',
    meterQuota: 500000,
    active: true,
    ...overrides,
  });

  const makeUsageDoc = (overrides = {}) => ({
    _id: '507f1f77bcf86cd799439099',
    organizationId: orgId,
    weekKey: '2026-W18',
    meterUsed: 0,
    meterQuota: 500000,
    planVersion: 'v1',
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: true,
        plans: ['pro'],
      },
    };

    mockUsageRepository = {
      findByWeek: jest.fn(),
      increment: jest.fn(),
      get: jest.fn(),
      reset: jest.fn(),
      incrementMeter: jest.fn(),
    };

    mockPlanService = {
      getActivePlan: jest.fn(),
    };

    mockMongooseUsage = {
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      findOneAndUpdate: jest.fn(),
    };

    mockMongooseSubscription = {
      find: jest.fn(),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../repositories/billing.usage.repository.js', () => ({
      default: mockUsageRepository,
    }));

    jest.unstable_mockModule('../services/billing.plan.service.js', () => ({
      default: mockPlanService,
    }));

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn((name) => {
          if (name === 'BillingUsage') return mockMongooseUsage;
          if (name === 'BillingSubscription') return mockMongooseSubscription;
          return {};
        }),
      },
    }));

    const mod = await import('../services/billing.reset.service.js');
    BillingResetService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isoWeekKey', () => {
    test('should return correct week key for a known Monday', () => {
      // 2026-04-27 is a Monday, ISO week 18
      const result = BillingResetService.isoWeekKey(new Date('2026-04-27'));
      expect(result).toBe('2026-W18');
    });

    test('should return correct week key for a Sunday (same ISO week as preceding Monday)', () => {
      // 2026-05-03 is Sunday, still ISO week 18
      const result = BillingResetService.isoWeekKey(new Date('2026-05-03'));
      expect(result).toBe('2026-W18');
    });

    test('should compute week 1 for first week of year', () => {
      // 2026-01-01 is Thursday — ISO week 1 of 2026
      const result = BillingResetService.isoWeekKey(new Date('2026-01-01'));
      expect(result).toBe('2026-W01');
    });
  });

  describe('resetWeek', () => {
    test('should return null when meterMode is disabled', async () => {
      mockConfig.billing.meterMode = false;
      const result = await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));
      expect(result).toBeNull();
    });

    test('should archive old week docs and upsert new week doc', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      mockUsageRepository.findByWeek.mockResolvedValue(null);
      const newDoc = makeUsageDoc({ weekKey: '2026-W18' });
      mockMongooseUsage.findOneAndUpdate.mockResolvedValue(newDoc);

      const result = await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      expect(mockMongooseUsage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: orgId, weekKey: { $ne: '2026-W18' } }),
        { $set: { archivedAt: expect.any(Date) } },
      );
      expect(result).toBe(newDoc);
    });

    test('should be idempotent — return existing doc if week already exists', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      const existingDoc = makeUsageDoc({ weekKey: '2026-W18' });
      mockUsageRepository.findByWeek.mockResolvedValue(existingDoc);

      const result = await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      // Should not call findOneAndUpdate since doc already exists
      expect(mockMongooseUsage.findOneAndUpdate).not.toHaveBeenCalled();
      expect(result).toBe(existingDoc);
    });

    test('should snapshot meterQuota and planVersion from active plan', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 1000000, version: 'v3' }));
      mockUsageRepository.findByWeek.mockResolvedValue(null);
      let capturedUpdate;
      mockMongooseUsage.findOneAndUpdate.mockImplementation((filter, update) => {
        capturedUpdate = update;
        return Promise.resolve(makeUsageDoc());
      });

      await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      expect(capturedUpdate.$setOnInsert.meterQuota).toBe(1000000);
      expect(capturedUpdate.$setOnInsert.planVersion).toBe('v3');
    });

    test('should use meterQuota=0 when no active plan exists', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(null);
      mockUsageRepository.findByWeek.mockResolvedValue(null);
      let capturedUpdate;
      mockMongooseUsage.findOneAndUpdate.mockImplementation((filter, update) => {
        capturedUpdate = update;
        return Promise.resolve(makeUsageDoc({ meterQuota: 0 }));
      });

      await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      expect(capturedUpdate.$setOnInsert.meterQuota).toBe(0);
      expect(capturedUpdate.$setOnInsert.planVersion).toBeNull();
    });

    test('should handle E11000 race by falling back to findByWeek', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      mockUsageRepository.findByWeek
        .mockResolvedValueOnce(null) // First call: doc not yet created
        .mockResolvedValueOnce(makeUsageDoc()); // Second call after E11000: doc exists
      const e11000 = new Error('E11000 duplicate key');
      e11000.code = 11000;
      mockMongooseUsage.findOneAndUpdate.mockRejectedValue(e11000);

      const result = await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      expect(result).toBeDefined();
      expect(mockUsageRepository.findByWeek).toHaveBeenCalledTimes(2);
    });
  });

  describe('resetAllDue', () => {
    test('should return processed=0, errors=0 when meterMode is disabled', async () => {
      mockConfig.billing.meterMode = false;
      const result = await BillingResetService.resetAllDue();
      expect(result).toEqual({ processed: 0, errors: 0 });
    });

    test('should call resetWeek for each active subscription', async () => {
      const now = new Date();
      const periodStart = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

      const leanMock = jest.fn().mockResolvedValue([
        { organizationId: '507f1f77bcf86cd799439011', currentPeriodStart: periodStart },
        { organizationId: '507f1f77bcf86cd799439022', currentPeriodStart: periodStart },
      ]);
      mockMongooseSubscription.find.mockReturnValue({ lean: leanMock });

      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      mockUsageRepository.findByWeek.mockResolvedValue(null);
      mockMongooseUsage.findOneAndUpdate.mockResolvedValue(makeUsageDoc());

      const result = await BillingResetService.resetAllDue();
      expect(result.processed).toBe(2);
      expect(result.errors).toBe(0);
    });

    test('should count errors when resetWeek fails for a subscription', async () => {
      const periodStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const leanMock = jest.fn().mockResolvedValue([
        { organizationId: '507f1f77bcf86cd799439011', currentPeriodStart: periodStart },
      ]);
      mockMongooseSubscription.find.mockReturnValue({ lean: leanMock });
      mockPlanService.getActivePlan.mockRejectedValue(new Error('DB error'));
      mockUsageRepository.findByWeek.mockResolvedValue(null);

      const result = await BillingResetService.resetAllDue();
      expect(result.errors).toBe(1);
      expect(result.processed).toBe(0);
    });
  });
});
