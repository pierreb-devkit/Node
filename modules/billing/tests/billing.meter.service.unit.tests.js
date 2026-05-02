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

    test('should return zero when positive costs floor to zero units', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1 } }));

      // 0.000001 * 1 * 1000 = 0.001 → floor = 0
      const costs = { scrap: 0.000001 };
      const result = await BillingMeterService.unitsFromCosts(costs, 'pro', 'v1');

      expect(result.totalUnits).toBe(0);
      expect(result.breakdown).toEqual({});
    });

    test('should return zero when costs is empty object', async () => {
      const result = await BillingMeterService.unitsFromCosts({}, 'pro', 'v1');
      expect(result).toEqual({ totalUnits: 0, breakdown: {} });
      expect(mockBillingPlanService.getPlanByVersion).not.toHaveBeenCalled();
    });

    test('should return zero when costs contains only zero values', async () => {
      const result = await BillingMeterService.unitsFromCosts({ digest: 0 }, 'pro', 'v1');
      expect(result.totalUnits).toBe(0);
      expect(result.breakdown).toEqual({});
      expect(mockBillingPlanService.getPlanByVersion).not.toHaveBeenCalled();
    });

    test('should apply versioned ratio for non-zero digest costs', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { digest: 2 } }));

      const result = await BillingMeterService.unitsFromCosts({ digest: 0.5 }, 'pro', 'v1');

      expect(mockBillingPlanService.getPlanByVersion).toHaveBeenCalledWith('pro', 'v1');
      expect(result).toEqual({ totalUnits: 1000, breakdown: { digest: 1000 } });
    });

    test('should return METER_RUN_BASE when costs is null', async () => {
      const result = await BillingMeterService.unitsFromCosts(null, 'pro', 'v1');
      expect(result.totalUnits).toBe(1);
    });

    test('should throw when plan version is missing and meterMode is enabled', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(null);

      const costs = { scrap: 0.001 };

      await expect(BillingMeterService.unitsFromCosts(costs, 'pro', 'nonexistent-version')).rejects.toThrow(
        '[billing.meter] missing plan version snapshot for (pro, nonexistent-version)',
      );
    });

    test('should use ratio=1 when plan not found and meterMode is disabled', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockConfig.billing.meterMode = false;
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(null);

      const result = await BillingMeterService.unitsFromCosts({ scrap: 0.002 }, 'pro', 'nonexistent-version');

      expect(result).toEqual({ totalUnits: 2, breakdown: { scrap: 2 } });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[billing.meter] getPlanByVersion(pro, nonexistent-version) returned null'),
      );
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
        '507f1f77bcf86cd799439033:initial',
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
        '507f1f77bcf86cd799439034:initial',
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
        '507f1f77bcf86cd799439035:initial',
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('attribute — per-step idempotency keys', () => {
    test('costsOverride empty object skips without writing idempotency key', async () => {
      const history = {
        _id: '507f1f77bcf86cd799439044',
        costs: { scrap: 1 },
        planId: 'pro',
        planVersion: 'v1',
      };

      const result = await BillingMeterService.attribute(history, orgId, {
        stepKey: 'digest',
        costsOverride: {},
      });

      expect(result).toEqual({
        applied: false,
        meterUsed: 0,
        extrasConsumed: 0,
        reason: 'zero_cost_skipped',
      });
      expect(mockBillingUsageService.incrementMeter).not.toHaveBeenCalled();
      expect(mockBillingExtraService.debit).not.toHaveBeenCalled();
    });

    test('costsOverride charges only the override delta', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1, digest: 2 } }));
      mockBillingUsageService.incrementMeter.mockResolvedValue({
        applied: true,
        meterUsed: 1000,
        extrasConsumed: 0,
      });

      const history = {
        _id: '507f1f77bcf86cd799439045',
        costs: { scrap: 10 },
        planId: 'pro',
        planVersion: 'v1',
      };

      const result = await BillingMeterService.attribute(history, orgId, {
        stepKey: 'digest',
        costsOverride: { digest: 0.5 },
      });

      expect(mockBillingUsageService.incrementMeter).toHaveBeenCalledWith(
        orgId,
        1000,
        { digest: 1000 },
        '507f1f77bcf86cd799439045:digest',
      );
      expect(result).toEqual({ applied: true, meterUsed: 1000, extrasConsumed: 0 });
    });

    test('options.costs is accepted as an alias when costsOverride is absent', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { digest: 2 } }));
      mockBillingUsageService.incrementMeter.mockResolvedValue({
        applied: true,
        meterUsed: 1000,
        extrasConsumed: 0,
      });

      const history = {
        _id: '507f1f77bcf86cd799439047',
        costs: { scrap: 10 },
        planId: 'pro',
        planVersion: 'v1',
      };

      await BillingMeterService.attribute(history, orgId, {
        stepKey: 'digest',
        costs: { digest: 0.5 },
      });

      expect(mockBillingUsageService.incrementMeter).toHaveBeenCalledWith(
        orgId,
        1000,
        { digest: 1000 },
        '507f1f77bcf86cd799439047:digest',
      );
    });

    test('explicit planId and ratioVersion override history fields', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(
        makePlan({ planId: 'override', version: '2026.05', ratios: { digest: 3 } }),
      );
      mockBillingUsageService.incrementMeter.mockResolvedValue({
        applied: true,
        meterUsed: 1500,
        extrasConsumed: 0,
      });

      const history = {
        _id: '507f1f77bcf86cd799439046',
        costs: { digest: 0.5 },
        planId: 'pro',
        planVersion: 'v1',
      };

      await BillingMeterService.attribute(history, orgId, {
        stepKey: 'digest',
        planId: 'override',
        ratioVersion: '2026.05',
      });

      expect(mockBillingPlanService.getPlanByVersion).toHaveBeenCalledWith('override', '2026.05');
      expect(mockBillingUsageService.incrementMeter).toHaveBeenCalledWith(
        orgId,
        1500,
        { digest: 1500 },
        '507f1f77bcf86cd799439046:digest',
      );
    });

    test('same history attributed twice with default stepKey: 2nd is no-op (regression)', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1 } }));
      // First call: applied
      mockBillingUsageService.incrementMeter.mockResolvedValueOnce({
        applied: true,
        meterUsed: 1000,
        extrasConsumed: 0,
      });
      // Second call: no-op (replay)
      mockBillingUsageService.incrementMeter.mockResolvedValueOnce({
        applied: false,
        meterUsed: 1000,
      });

      const history = {
        _id: '507f1f77bcf86cd799439040',
        costs: { scrap: 1 },
        planId: 'pro',
        planVersion: 'v1',
      };

      const first = await BillingMeterService.attribute(history, orgId);
      const second = await BillingMeterService.attribute(history, orgId);

      expect(first.applied).toBe(true);
      expect(second.applied).toBe(false);

      // Both calls must use the same idempotency key (stepKey defaults to 'initial')
      expect(mockBillingUsageService.incrementMeter).toHaveBeenNthCalledWith(
        1, orgId, expect.any(Number), expect.any(Object), '507f1f77bcf86cd799439040:initial',
      );
      expect(mockBillingUsageService.incrementMeter).toHaveBeenNthCalledWith(
        2, orgId, expect.any(Number), expect.any(Object), '507f1f77bcf86cd799439040:initial',
      );
    });

    test('same history attributed with {stepKey:"initial"} then {stepKey:"digest"}: both charged', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1 } }));
      mockBillingUsageService.incrementMeter.mockResolvedValue({
        applied: true,
        meterUsed: 500,
        extrasConsumed: 0,
      });

      const history = {
        _id: '507f1f77bcf86cd799439041',
        costs: { scrap: 0.5 },
        planId: 'pro',
        planVersion: 'v1',
      };

      const initial = await BillingMeterService.attribute(history, orgId, { stepKey: 'initial' });
      const digest = await BillingMeterService.attribute(history, orgId, { stepKey: 'digest' });

      expect(initial.applied).toBe(true);
      expect(digest.applied).toBe(true);

      expect(mockBillingUsageService.incrementMeter).toHaveBeenNthCalledWith(
        1, orgId, expect.any(Number), expect.any(Object), '507f1f77bcf86cd799439041:initial',
      );
      expect(mockBillingUsageService.incrementMeter).toHaveBeenNthCalledWith(
        2, orgId, expect.any(Number), expect.any(Object), '507f1f77bcf86cd799439041:digest',
      );
    });

    test('same history attributed with {stepKey:"fix:1"} then {stepKey:"fix:2"}: both charged', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1 } }));
      mockBillingUsageService.incrementMeter.mockResolvedValue({
        applied: true,
        meterUsed: 200,
        extrasConsumed: 0,
      });

      const history = {
        _id: '507f1f77bcf86cd799439042',
        costs: { scrap: 0.2 },
        planId: 'pro',
        planVersion: 'v1',
      };

      const fix1 = await BillingMeterService.attribute(history, orgId, { stepKey: 'fix:1' });
      const fix2 = await BillingMeterService.attribute(history, orgId, { stepKey: 'fix:2' });

      expect(fix1.applied).toBe(true);
      expect(fix2.applied).toBe(true);

      expect(mockBillingUsageService.incrementMeter).toHaveBeenNthCalledWith(
        1, orgId, expect.any(Number), expect.any(Object), '507f1f77bcf86cd799439042:fix:1',
      );
      expect(mockBillingUsageService.incrementMeter).toHaveBeenNthCalledWith(
        2, orgId, expect.any(Number), expect.any(Object), '507f1f77bcf86cd799439042:fix:2',
      );
    });

    test('invalid stepKey (special chars) throws instead of silently falling back to "initial"', async () => {
      // Previously: invalid stepKey silently fell back to 'initial', which collides with the
      // actual initial attribution key and would silently drop subsequent step charges.
      // Fix: throw immediately so callers can detect and correct the issue.
      const history = {
        _id: '507f1f77bcf86cd799439099',
        costs: { scrap: 0.1 },
        planId: 'pro',
        planVersion: 'v1',
      };

      await expect(
        BillingMeterService.attribute(history, orgId, { stepKey: 'bad key! @#$' }),
      ).rejects.toThrow('[billing.meter] invalid stepKey');

      // incrementMeter must NOT be called — the throw happens before any DB write
      expect(mockBillingUsageService.incrementMeter).not.toHaveBeenCalled();
    });

    test('null and undefined stepKey fall back to initial while invalid values throw', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1 } }));
      mockBillingUsageService.incrementMeter.mockResolvedValue({
        applied: true,
        meterUsed: 100,
        extrasConsumed: 0,
      });
      const history = {
        _id: '507f1f77bcf86cd799439098',
        costs: { scrap: 0.1 },
        planId: 'pro',
        planVersion: 'v1',
      };

      await expect(BillingMeterService.attribute(history, orgId, { stepKey: null })).resolves.toEqual({
        applied: true,
        meterUsed: 100,
        extrasConsumed: 0,
      });
      await expect(BillingMeterService.attribute(history, orgId, { stepKey: undefined })).resolves.toEqual({
        applied: true,
        meterUsed: 100,
        extrasConsumed: 0,
      });

      expect(mockBillingUsageService.incrementMeter).toHaveBeenNthCalledWith(
        1, orgId, expect.any(Number), expect.any(Object), '507f1f77bcf86cd799439098:initial',
      );
      expect(mockBillingUsageService.incrementMeter).toHaveBeenNthCalledWith(
        2, orgId, expect.any(Number), expect.any(Object), '507f1f77bcf86cd799439098:initial',
      );

      await expect(
        BillingMeterService.attribute(history, orgId, { stepKey: 123 }),
      ).rejects.toThrow('[billing.meter] invalid stepKey');
      await expect(
        BillingMeterService.attribute(history, orgId, { stepKey: 'bad space' }),
      ).rejects.toThrow('[billing.meter] invalid stepKey');
    });

    test('replay of {stepKey:"digest"} is blocked (idempotent)', async () => {
      mockBillingPlanService.getPlanByVersion.mockResolvedValue(makePlan({ ratios: { scrap: 1 } }));
      // First digest call: applied
      mockBillingUsageService.incrementMeter.mockResolvedValueOnce({
        applied: true,
        meterUsed: 300,
        extrasConsumed: 0,
      });
      // Replay: no-op
      mockBillingUsageService.incrementMeter.mockResolvedValueOnce({
        applied: false,
        meterUsed: 300,
      });

      const history = {
        _id: '507f1f77bcf86cd799439043',
        costs: { scrap: 0.3 },
        planId: 'pro',
        planVersion: 'v1',
      };

      const first = await BillingMeterService.attribute(history, orgId, { stepKey: 'digest' });
      const replay = await BillingMeterService.attribute(history, orgId, { stepKey: 'digest' });

      expect(first.applied).toBe(true);
      expect(replay.applied).toBe(false);

      expect(mockBillingUsageService.incrementMeter).toHaveBeenCalledTimes(2);
      // Both calls use the same digest key
      for (const call of mockBillingUsageService.incrementMeter.mock.calls) {
        expect(call[3]).toBe('507f1f77bcf86cd799439043:digest');
      }
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
