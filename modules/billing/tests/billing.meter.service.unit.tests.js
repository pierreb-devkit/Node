/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.meter.service.js
 */
describe('BillingMeterService unit tests:', () => {
  let BillingMeterService;
  let mockBillingPlanService;
  let mockConfig;
  let mockBillingUsageService;
  let mockBillingExtraService;

  const orgId = '507f1f77bcf86cd799439011';

  /**
   * @param {Object} [overrides={}] - Fields to override on the stub plan.
   * @returns {Object} A stub BillingPlan document.
   */
  const makePlan = (overrides = {}) => ({
    _id: '507f1f77bcf86cd799439022',
    planId: 'pro',
    version: 'v1',
    meterQuota: 500000,
    ratios: { scrap: 1, autofix: 2, wizard: 5 },
    active: true,
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
          maxUnitsPerOperation: 10000,
        },
        packs: [],
      },
    };

    mockBillingPlanService = {
      getPlanByVersion: jest.fn(),
      getActivePlan: jest.fn(),
    };

    mockBillingUsageService = {
      incrementMeter: jest.fn(),
    };

    mockBillingExtraService = {
      debit: jest.fn(),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../services/billing.plan.service.js', () => ({
      default: mockBillingPlanService,
    }));

    jest.unstable_mockModule('../services/billing.usage.service.js', () => ({
      default: mockBillingUsageService,
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: mockBillingExtraService,
    }));

    const mod = await import('../services/billing.meter.service.js');
    BillingMeterService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('METER_RUN_BASE constant', () => {
    test('should export METER_RUN_BASE from config', async () => {
      const mod = await import('../services/billing.meter.service.js');
      expect(mod.METER_RUN_BASE).toBe(1);
    });
  });

  describe('unitsFromCosts', () => {
    test('should compute units correctly using plan ratios', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan());

      const costs = { scrap: 0.001, autofix: 0.002 };
      const result = await BillingMeterService.unitsFromCosts(costs, 'pro', 'v1');

      expect(mockBillingPlanService.getPlanByVersion).toHaveBeenCalledWith('pro', 'v1');
      // scrap: floor(0.001 * 1 * 1000) = 1
      // autofix: floor(0.002 * 2 * 1000) = 4
      // total = 5
      expect(result.totalUnits).toBe(5);
      expect(result.breakdown.scrap).toBe(1);
      expect(result.breakdown.autofix).toBe(4);
    });

    test('should use ratio=1 as default when feature key not in plan ratios', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: {} }));

      const costs = { unknown_feature: 0.001 };
      const result = await BillingMeterService.unitsFromCosts(costs, 'pro', 'v1');

      // floor(0.001 * 1 * 1000) = 1
      expect(result.totalUnits).toBe(1);
      expect(result.breakdown.unknown_feature).toBe(1);
    });

    test('should enforce METER_RUN_BASE floor when costs are tiny', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1 } }));

      // 0.000001 * 1 * 1000 = 0.001 → floor = 0 → total = 0, floor to METER_RUN_BASE
      const costs = { scrap: 0.000001 };
      const result = await BillingMeterService.unitsFromCosts(costs, 'pro', 'v1');

      expect(result.totalUnits).toBe(1); // METER_RUN_BASE
    });

    test('should return METER_RUN_BASE when costs is empty object', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan());

      const result = await BillingMeterService.unitsFromCosts({}, 'pro', 'v1');
      expect(result.totalUnits).toBe(1);
      expect(result.breakdown).toEqual({});
    });

    test('should return METER_RUN_BASE when costs is null', async () => {
      const result = await BillingMeterService.unitsFromCosts(null, 'pro', 'v1');
      expect(result.totalUnits).toBe(1);
    });

    test('should use ratio=1 when plan not found (null)', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(null);

      const costs = { scrap: 0.001 };
      const result = await BillingMeterService.unitsFromCosts(costs, 'pro', 'v1');

      // ratio defaults to 1: floor(0.001 * 1 * 1000) = 1
      expect(result.totalUnits).toBe(1);
    });

    test('should skip cost entries with non-numeric or zero values', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1 } }));

      const costs = { scrap: 0.001, bad: 'notanumber', zero: 0, neg: -1 };
      const result = await BillingMeterService.unitsFromCosts(costs, 'pro', 'v1');

      expect(result.breakdown.bad).toBeUndefined();
      expect(result.breakdown.zero).toBeUndefined();
      expect(result.breakdown.neg).toBeUndefined();
      expect(result.breakdown.scrap).toBe(1);
    });
  });

  describe('attribute — no-op when meterMode=false', () => {
    test('should return applied=false when meterMode is disabled', async () => {
      mockConfig.billing.meterMode = false;

      const history = { _id: '507f1f77bcf86cd799439033', costs: { scrap: 0.001 }, planId: 'pro', planVersion: 'v1' };
      const result = await BillingMeterService.attribute(history, orgId);

      expect(result.applied).toBe(false);
      expect(result.meterUsed).toBe(0);
    });
  });

  describe('attribute — maxUnitsPerOperation cap', () => {
    test('caps metered units when computed units exceed config cap', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1 } }));
      mockBillingUsageService.incrementMeter.mockResolvedValue({
        applied: true,
        meterUsed: 10000,
        extrasConsumed: 0,
      });

      const history = {
        _id: '507f1f77bcf86cd799439033',
        costs: { scrap: 20 },
        planId: 'pro',
        planVersion: 'v1',
      };

      const result = await BillingMeterService.attribute(history, orgId);

      expect(mockBillingUsageService.incrementMeter).toHaveBeenCalledWith(
        orgId,
        10000,
        { scrap: 10000 },
        '507f1f77bcf86cd799439033',
      );
      expect(warnSpy).toHaveBeenCalledWith(
        '[billing.meter] units capped: requested 20000, cap 10000, applied 10000',
      );
      expect(result).toEqual({ applied: true, meterUsed: 10000, extrasConsumed: 0 });
    });

    test('does not clamp when units are within the configured cap', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1 } }));
      mockBillingUsageService.incrementMeter.mockResolvedValue({
        applied: true,
        meterUsed: 5000,
        extrasConsumed: 0,
      });

      const history = {
        _id: '507f1f77bcf86cd799439034',
        costs: { scrap: 5 },
        planId: 'pro',
        planVersion: 'v1',
      };

      await BillingMeterService.attribute(history, orgId);

      expect(mockBillingUsageService.incrementMeter).toHaveBeenCalledWith(
        orgId,
        5000,
        { scrap: 5000 },
        '507f1f77bcf86cd799439034',
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test('does not clamp when maxUnitsPerOperation is undefined', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      delete mockConfig.billing.meter.maxUnitsPerOperation;
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1 } }));
      mockBillingUsageService.incrementMeter.mockResolvedValue({
        applied: true,
        meterUsed: 20000,
        extrasConsumed: 0,
      });

      const history = {
        _id: '507f1f77bcf86cd799439035',
        costs: { scrap: 20 },
        planId: 'pro',
        planVersion: 'v1',
      };

      await BillingMeterService.attribute(history, orgId);

      expect(mockBillingUsageService.incrementMeter).toHaveBeenCalledWith(
        orgId,
        20000,
        { scrap: 20000 },
        '507f1f77bcf86cd799439035',
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('capBreakdown — proportional rescaling', () => {
    test('rescales a multi-key breakdown proportionally to the capped total', async () => {
      const mod = await import('../services/billing.meter.service.js');
      const { capBreakdown } = mod.default;

      // breakdown: { scrap: 6000, autofix: 4000 } → total = 10000, cap to 5000
      // scrap:  floor(6000 * 5000/10000) = 3000
      // autofix: floor(4000 * 5000/10000) = 2000
      // allocated = 5000, remainder = 0
      const result = capBreakdown({ scrap: 6000, autofix: 4000 }, 5000, 10000);

      expect(result.scrap).toBe(3000);
      expect(result.autofix).toBe(2000);
      expect(result.scrap + result.autofix).toBe(5000);
    });

    test('distributes floor remainder to the largest bucket first', async () => {
      const mod = await import('../services/billing.meter.service.js');
      const { capBreakdown } = mod.default;

      // breakdown: { a: 3, b: 2, c: 1 } → total = 6, cap to 4
      // a: floor(3 * 4/6) = floor(2) = 2
      // b: floor(2 * 4/6) = floor(1.33) = 1
      // c: floor(1 * 4/6) = floor(0.66) = 0
      // allocated = 3, remainder = 1 → add 1 to largest bucket (a)
      const result = capBreakdown({ a: 3, b: 2, c: 1 }, 4, 6);

      expect(result.a + result.b + (result.c ?? 0)).toBe(4);
      expect(result.a).toBeGreaterThanOrEqual(result.b);
    });

    test('returns empty object when breakdown has no valid entries', async () => {
      const mod = await import('../services/billing.meter.service.js');
      const { capBreakdown } = mod.default;

      const result = capBreakdown({}, 5000, 10000);

      expect(Object.keys(result)).toHaveLength(0);
    });
  });
});
