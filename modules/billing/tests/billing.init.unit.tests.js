/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.init ensureSeeded integration.
 */
describe('billing.init ensureSeeded unit tests:', () => {
  let billingInit;
  let mockBillingPlanService;
  let mockConfig;

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
});
