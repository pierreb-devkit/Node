/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.usage.service.js — meter extensions (PR-N2)
 */
describe('BillingUsageService — meter extensions unit tests:', () => {
  let BillingUsageService;
  let mockUsageRepository;
  let mockPlanService;
  let mockConfig;

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
    month: '2026-05',
    meterUsed: 0,
    meterQuota: 500000,
    planVersion: 'v1',
    alertedAt80: null,
    alertedAt100: null,
    consumedHistoryIds: [],
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: true,
        plans: ['pro'],
        meter: {
          runBaseUnits: 1,
          dollarsToUnitRatio: 1000,
        },
      },
    };

    mockUsageRepository = {
      get: jest.fn(),
      increment: jest.fn(),
      reset: jest.fn(),
      findByWeek: jest.fn(),
      incrementMeter: jest.fn(),
      markThreshold: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    mockPlanService = {
      getActivePlan: jest.fn(),
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

    const mod = await import('../services/billing.usage.service.js');
    BillingUsageService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('currentWeekKey', () => {
    test('should return a string matching YYYY-Www format', () => {
      const result = BillingUsageService.currentWeekKey();
      expect(result).toMatch(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/);
    });

    test('should return consistent result on same day', () => {
      const r1 = BillingUsageService.currentWeekKey();
      const r2 = BillingUsageService.currentWeekKey();
      expect(r1).toBe(r2);
    });
  });

  describe('incrementMeter — no-op when meterMode=false', () => {
    test('should return applied=false immediately', async () => {
      mockConfig.billing.meterMode = false;

      const result = await BillingUsageService.incrementMeter(orgId, 100, {}, 'key_1');
      expect(result.applied).toBe(false);
      expect(result.meterUsed).toBe(0);
      expect(mockUsageRepository.incrementMeter).not.toHaveBeenCalled();
    });
  });

  describe('incrementMeter — happy path', () => {
    test('should attribute units and return applied=true', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      const updatedDoc = makeUsageDoc({ meterUsed: 100 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 100, { scrap: 100 }, 'hist_001');

      expect(mockUsageRepository.incrementMeter).toHaveBeenCalledWith(
        orgId,
        expect.stringMatching(/^\d{4}-W\d{2}$/),
        100,
        { scrap: 100 },
        'hist_001',
        expect.objectContaining({ meterQuota: 500000, planVersion: 'v1' }),
      );
      expect(result.applied).toBe(true);
      expect(result.meterUsed).toBe(100);
      expect(result.extrasConsumed).toBe(0);
    });

    test('should return applied=false and fetch existing doc on replay', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      // repo returns null = replay
      mockUsageRepository.incrementMeter.mockResolvedValue(null);
      const existingDoc = makeUsageDoc({ meterUsed: 100 });
      mockUsageRepository.findByWeek.mockResolvedValue(existingDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_replay');

      expect(result.applied).toBe(false);
      expect(result.meterUsed).toBe(100);
    });

    test('incrementMeter same idempotencyKey twice → second is no-op', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      mockUsageRepository.incrementMeter
        .mockResolvedValueOnce(makeUsageDoc({ meterUsed: 100 }))
        .mockResolvedValueOnce(null); // second call: replay
      mockUsageRepository.findByWeek.mockResolvedValue(makeUsageDoc({ meterUsed: 100 }));

      const r1 = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_idempotent');
      const r2 = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_idempotent');

      expect(r1.applied).toBe(true);
      expect(r2.applied).toBe(false);
    });
  });

  describe('incrementMeter — overflow to extras', () => {
    test('should compute extrasConsumed when meterUsed exceeds quota', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      // meterUsed = 510000, quota = 500000 → 10000 overflow
      const updatedDoc = makeUsageDoc({ meterUsed: 510000, meterQuota: 500000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 50000, {}, 'hist_overflow');

      expect(result.extrasConsumed).toBe(10000);
    });

    test('should return extrasConsumed=0 when within quota', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 100, meterQuota: 500000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_within');

      expect(result.extrasConsumed).toBe(0);
    });
  });

  describe('incrementMeter — threshold detection', () => {
    test('should emit threshold 80 alert when crossing 80% (once per cycle)', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      // 80% of 500000 = 400000 → crossing at meterUsed = 400001
      const updatedDoc = makeUsageDoc({ meterUsed: 400001, meterQuota: 500000, alertedAt80: null, alertedAt100: null });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_80pct');

      expect(result.alertCrossed).toBe('80');
      // Should mark alertedAt80 atomically via repository
      expect(mockUsageRepository.markThreshold).toHaveBeenCalledWith(updatedDoc._id, 'alertedAt80');
    });

    test('should NOT re-emit threshold 80 when already alerted (alertedAt80 set)', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({
        meterUsed: 450000,
        meterQuota: 500000,
        alertedAt80: new Date(), // already alerted
        alertedAt100: null,
      });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_80pct_dedup');

      expect(result.alertCrossed).toBeNull();
    });

    test('should emit threshold 100 alert when at 100%', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({
        meterUsed: 500001,
        meterQuota: 500000,
        alertedAt80: new Date(), // 80 already sent
        alertedAt100: null,
      });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_100pct');

      expect(result.alertCrossed).toBe('100');
    });

    test('should NOT re-emit threshold 100 when already alerted', async () => {
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({
        meterUsed: 600000,
        meterQuota: 500000,
        alertedAt80: new Date(),
        alertedAt100: new Date(), // already alerted
      });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_100pct_dedup');

      expect(result.alertCrossed).toBeNull();
    });
  });

  describe('getMeter', () => {
    test('should return null when meterMode is disabled', async () => {
      mockConfig.billing.meterMode = false;
      const result = await BillingUsageService.getMeter(orgId);
      expect(result).toBeNull();
    });

    test('should return current week usage doc', async () => {
      const doc = makeUsageDoc({ meterUsed: 200, meterQuota: 500000 });
      mockUsageRepository.findByWeek.mockResolvedValue(doc);

      const result = await BillingUsageService.getMeter(orgId);

      expect(mockUsageRepository.findByWeek).toHaveBeenCalledWith(
        orgId,
        expect.stringMatching(/^\d{4}-W\d{2}$/),
      );
      expect(result.meterUsed).toBe(200);
    });

    test('should return null when no doc for current week', async () => {
      mockUsageRepository.findByWeek.mockResolvedValue(null);
      const result = await BillingUsageService.getMeter(orgId);
      expect(result).toBeNull();
    });
  });
});
