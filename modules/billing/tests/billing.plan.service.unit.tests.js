/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.plan.service.js — config-static plan lookup.
 */
describe('BillingPlanService unit tests:', () => {
  let BillingPlanService;
  let mockConfig;

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: true,
        planDefinitions: [
          { planId: 'free', meterQuota: 0, ratios: { default: 1 }, version: '2026.05' },
          { planId: 'growth', meterQuota: 1600, ratios: { scrap: 1, autofix: 2 }, version: '2026.05' },
          { planId: 'pro', meterQuota: 8000, ratios: { scrap: 1, autofix: 2 }, version: '2026.05' },
        ],
        meter: {
          ratioVersion: '2026.05',
        },
      },
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    const mod = await import('../services/billing.plan.service.js');
    BillingPlanService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getActivePlan', () => {
    test('returns plan from config for known planId', () => {
      const result = BillingPlanService.getActivePlan('pro');

      expect(result).not.toBeNull();
      expect(result.planId).toBe('pro');
      expect(result.meterQuota).toBe(8000);
      expect(result.version).toBe('2026.05');
      expect(result.ratios).toEqual({ scrap: 1, autofix: 2 });
    });

    test('returns null for unknown planId', () => {
      const result = BillingPlanService.getActivePlan('unknown');
      expect(result).toBeNull();
    });

    test('returns free plan with meterQuota=0', () => {
      const result = BillingPlanService.getActivePlan('free');
      expect(result).not.toBeNull();
      expect(result.meterQuota).toBe(0);
    });

    test('version falls back to meter.ratioVersion when not in planDefinition', () => {
      mockConfig.billing.planDefinitions = [
        { planId: 'pro', meterQuota: 8000, ratios: {} },
      ];
      const result = BillingPlanService.getActivePlan('pro');
      expect(result.version).toBe('2026.05');
    });

    test('version falls back to "v1" when neither planDefinition.version nor meter.ratioVersion is set', () => {
      mockConfig.billing.planDefinitions = [
        { planId: 'pro', meterQuota: 8000, ratios: {} },
      ];
      delete mockConfig.billing.meter;
      const result = BillingPlanService.getActivePlan('pro');
      expect(result.version).toBe('v1');
    });

    test('is synchronous (returns plain object, not a Promise)', () => {
      const result = BillingPlanService.getActivePlan('pro');
      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof result).toBe('object');
    });
  });

  describe('getPlanByVersion', () => {
    test('returns plan when version matches', () => {
      const result = BillingPlanService.getPlanByVersion('pro', '2026.05');
      expect(result).not.toBeNull();
      expect(result.planId).toBe('pro');
      expect(result.version).toBe('2026.05');
    });

    test('returns null when planId is unknown', () => {
      const result = BillingPlanService.getPlanByVersion('unknown', '2026.05');
      expect(result).toBeNull();
    });

    test('returns null when version does not match configured version', () => {
      const result = BillingPlanService.getPlanByVersion('pro', '2025.01');
      expect(result).toBeNull();
    });

    test('is synchronous (returns plain object or null, not a Promise)', () => {
      const result = BillingPlanService.getPlanByVersion('pro', '2026.05');
      expect(result).not.toBeInstanceOf(Promise);
    });
  });
});
