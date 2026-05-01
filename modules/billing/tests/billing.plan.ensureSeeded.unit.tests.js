/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for BillingPlanService.ensureSeeded
 */
describe('BillingPlanService.ensureSeeded unit tests:', () => {
  let BillingPlanService;
  let mockBillingPlanRepository;
  let mockConfig;

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: true,
        planDefinitions: [],
      },
    };

    mockBillingPlanRepository = {
      findActive: jest.fn(),
      findByVersion: jest.fn(),
      deactivateAll: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../repositories/billing.plan.repository.js', () => ({
      default: mockBillingPlanRepository,
    }));

    const mod = await import('../services/billing.plan.service.js');
    BillingPlanService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('meterMode=false returns zeroes and never touches the repository', async () => {
    mockConfig.billing.meterMode = false;

    const result = await BillingPlanService.ensureSeeded();

    expect(result).toEqual({ seeded: 0, skipped: 0 });
    expect(mockBillingPlanRepository.findActive).not.toHaveBeenCalled();
    expect(mockBillingPlanRepository.create).not.toHaveBeenCalled();
  });

  test('meterMode=true with empty planDefinitions array returns zeroes', async () => {
    const result = await BillingPlanService.ensureSeeded();

    expect(result).toEqual({ seeded: 0, skipped: 0 });
    expect(mockBillingPlanRepository.findActive).not.toHaveBeenCalled();
    expect(mockBillingPlanRepository.create).not.toHaveBeenCalled();
  });

  test('meterMode=true with 3 planDefinitions and none existing seeds 3 plans', async () => {
    mockConfig.billing.planDefinitions = [
      { planId: 'free', meterQuota: 0, ratios: { default: 1 } },
      { planId: 'starter', meterQuota: 50000, ratios: { default: 1 } },
      { planId: 'pro', meterQuota: 500000, ratios: { default: 2 } },
    ];
    mockBillingPlanRepository.findActive.mockResolvedValue(null);
    // count=0 → version 'v1' for each plan
    mockBillingPlanRepository.count.mockResolvedValue(0);
    mockBillingPlanRepository.create.mockResolvedValue({});

    const result = await BillingPlanService.ensureSeeded();

    expect(result).toEqual({ seeded: 3, skipped: 0 });
    expect(mockBillingPlanRepository.findActive).toHaveBeenCalledTimes(3);
    expect(mockBillingPlanRepository.count).toHaveBeenCalledTimes(3);
    expect(mockBillingPlanRepository.create).toHaveBeenCalledTimes(3);
    expect(mockBillingPlanRepository.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ planId: 'free', version: 'v1', meterQuota: 0, ratios: { default: 1 }, active: true }),
    );
  });

  test('meterMode=true with 3 planDefinitions and 1 existing seeds 2 and skips 1', async () => {
    mockConfig.billing.planDefinitions = [
      { planId: 'free', meterQuota: 0, ratios: { default: 1 } },
      { planId: 'starter', meterQuota: 50000, ratios: { default: 1 } },
      { planId: 'pro', meterQuota: 500000, ratios: { default: 1 } },
    ];
    mockBillingPlanRepository.findActive
      .mockResolvedValueOnce({ planId: 'free', version: 'v1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockBillingPlanRepository.count.mockResolvedValue(0);
    mockBillingPlanRepository.create.mockResolvedValue({});

    const result = await BillingPlanService.ensureSeeded();

    expect(result).toEqual({ seeded: 2, skipped: 1 });
    expect(mockBillingPlanRepository.create).toHaveBeenCalledTimes(2);
    expect(mockBillingPlanRepository.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ planId: 'starter', version: 'v1' }),
    );
    expect(mockBillingPlanRepository.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ planId: 'pro', version: 'v1' }),
    );
  });

  test('count > 0 yields next version string correctly', async () => {
    mockConfig.billing.planDefinitions = [
      { planId: 'pro', meterQuota: 500000, ratios: { default: 1 } },
    ];
    mockBillingPlanRepository.findActive.mockResolvedValue(null);
    // Existing inactive v1 is present (total count = 1)
    mockBillingPlanRepository.count.mockResolvedValue(1);
    mockBillingPlanRepository.create.mockResolvedValue({});

    const result = await BillingPlanService.ensureSeeded();

    expect(result).toEqual({ seeded: 1, skipped: 0 });
    expect(mockBillingPlanRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'pro', version: 'v2' }),
    );
  });

  test('E11000 on create is absorbed as a skip (concurrent pod race)', async () => {
    mockConfig.billing.planDefinitions = [
      { planId: 'free', meterQuota: 0, ratios: { default: 1 } },
      { planId: 'pro', meterQuota: 500000, ratios: { default: 1 } },
    ];
    mockBillingPlanRepository.findActive.mockResolvedValue(null);
    mockBillingPlanRepository.count.mockResolvedValue(0);
    // First create throws E11000; second succeeds
    const e11000 = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    mockBillingPlanRepository.create.mockRejectedValueOnce(e11000).mockResolvedValueOnce({});

    const result = await BillingPlanService.ensureSeeded();

    expect(result).toEqual({ seeded: 1, skipped: 1 });
  });

  test('non-E11000 error on create propagates and aborts', async () => {
    mockConfig.billing.planDefinitions = [
      { planId: 'pro', meterQuota: 500000, ratios: { default: 1 } },
    ];
    mockBillingPlanRepository.findActive.mockResolvedValue(null);
    mockBillingPlanRepository.count.mockResolvedValue(0);
    mockBillingPlanRepository.create.mockRejectedValue(new Error('DB connection lost'));

    await expect(BillingPlanService.ensureSeeded()).rejects.toThrow('DB connection lost');
  });

  // Version Namespace Contract tests (#3574)

  test('explicit version in planDefinitions entry is used as-is (YYYY.MM contract)', async () => {
    mockConfig.billing.planDefinitions = [
      { planId: 'pro', meterQuota: 500000, ratios: { default: 1 }, version: '2026.05' },
    ];
    mockBillingPlanRepository.findActive.mockResolvedValue(null);
    mockBillingPlanRepository.create.mockResolvedValue({});

    await BillingPlanService.ensureSeeded();

    // count should NOT be called — version resolved from explicit entry
    expect(mockBillingPlanRepository.count).not.toHaveBeenCalled();
    expect(mockBillingPlanRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'pro', version: '2026.05' }),
    );
  });

  test('no explicit version + meter.ratioVersion in config → uses ratioVersion (YYYY.MM fallback)', async () => {
    mockConfig.billing.planDefinitions = [
      { planId: 'starter', meterQuota: 50000, ratios: { default: 1 } },
    ];
    mockConfig.billing.meter = { ratioVersion: '2026.05' };
    mockBillingPlanRepository.findActive.mockResolvedValue(null);
    mockBillingPlanRepository.create.mockResolvedValue({});

    await BillingPlanService.ensureSeeded();

    // count should NOT be called — version resolved from ratioVersion
    expect(mockBillingPlanRepository.count).not.toHaveBeenCalled();
    expect(mockBillingPlanRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'starter', version: '2026.05' }),
    );
  });

  test('no explicit version + no ratioVersion → falls back to count-derived v${n+1}', async () => {
    mockConfig.billing.planDefinitions = [
      { planId: 'free', meterQuota: 0, ratios: { default: 1 } },
    ];
    // Ensure no meter.ratioVersion
    mockConfig.billing.meter = { runBaseUnits: 1, dollarsToUnitRatio: 1000 };
    mockBillingPlanRepository.findActive.mockResolvedValue(null);
    mockBillingPlanRepository.count.mockResolvedValue(0);
    mockBillingPlanRepository.create.mockResolvedValue({});

    await BillingPlanService.ensureSeeded();

    expect(mockBillingPlanRepository.count).toHaveBeenCalledTimes(1);
    expect(mockBillingPlanRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'free', version: 'v1' }),
    );
  });
});
