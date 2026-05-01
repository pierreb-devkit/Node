/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.init — ensureSeeded integration and boot validator.
 */
describe('billing.init unit tests:', () => {
  let billingInit;
  let mockBillingPlanService;
  let mockConfig;
  let mockDistinct;
  let mockMongoose;

  const mockApp = {};

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: false,
        packs: [],
      },
    };

    mockBillingPlanService = {
      ensureSeeded: jest.fn().mockResolvedValue({ seeded: 0, skipped: 0 }),
    };

    mockDistinct = jest.fn().mockResolvedValue([]);
    mockMongoose = {
      model: jest.fn().mockReturnValue({ distinct: mockDistinct }),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../services/billing.plan.service.js', () => ({
      default: mockBillingPlanService,
    }));

    // Stub analytics and events to avoid side effects
    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { groupIdentify: jest.fn() },
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { on: jest.fn(), emit: jest.fn() },
    }));

    jest.unstable_mockModule('mongoose', () => ({
      default: mockMongoose,
    }));

    const mod = await import('../billing.init.js');
    billingInit = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('ensureSeeded is called at init when meterMode=false', async () => {
    await billingInit(mockApp);
    expect(mockBillingPlanService.ensureSeeded).toHaveBeenCalledTimes(1);
  });

  test('ensureSeeded failure is swallowed when meterMode=false', async () => {
    mockBillingPlanService.ensureSeeded.mockRejectedValue(new Error('DB error'));

    // Should not throw — meterMode=false means graceful degradation
    await expect(billingInit(mockApp)).resolves.toBeUndefined();
  });

  test('ensureSeeded failure re-throws when meterMode=true (fail-fast)', async () => {
    mockConfig.billing.meterMode = true;
    mockBillingPlanService.ensureSeeded.mockRejectedValue(new Error('seed failure'));

    await expect(billingInit(mockApp)).rejects.toThrow('seed failure');
  });

  test('ensureSeeded success with seeded>0 logs info and resolves', async () => {
    mockBillingPlanService.ensureSeeded.mockResolvedValue({ seeded: 2, skipped: 1 });
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    await billingInit(mockApp);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('seeded 2 plan(s)'),
    );
  });

  test('boot validator warns on orphaned Subscription.plan values when meterMode=true', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.plans = ['free', 'starter', 'pro'];

    // Stub distinct to return a known plan + an orphaned plan
    mockDistinct.mockResolvedValue(['free', 'legacy_plan']);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await billingInit(mockApp);

    expect(mockDistinct).toHaveBeenCalledWith('plan');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"legacy_plan" not in planDefinitions'),
    );
    // Known plan 'free' must NOT trigger a warning
    const warnings = warnSpy.mock.calls.map((c) => c[0]);
    expect(warnings.some((w) => w.includes('"free"'))).toBe(false);
  });

  test('boot validator failure does not crash boot', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.plans = ['free'];

    // Subscription model throws (e.g. not yet registered at early init)
    mockMongoose.model.mockImplementation(() => {
      throw new Error('model not registered');
    });

    // Must resolve without throwing
    await expect(billingInit(mockApp)).resolves.toBeUndefined();
  });
});
