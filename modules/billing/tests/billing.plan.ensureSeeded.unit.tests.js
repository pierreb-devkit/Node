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
        planDefinitions: {},
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

  test('meterMode=true with empty planDefinitions returns zeroes', async () => {
    const result = await BillingPlanService.ensureSeeded();

    expect(result).toEqual({ seeded: 0, skipped: 0 });
    expect(mockBillingPlanRepository.findActive).not.toHaveBeenCalled();
    expect(mockBillingPlanRepository.create).not.toHaveBeenCalled();
  });

  test('meterMode=true with 3 planDefinitions and none existing seeds 3 plans', async () => {
    mockConfig.billing.planDefinitions = {
      free: { meterQuota: 0, ratios: { default: 1 } },
      starter: { meterQuota: 50000, ratios: { default: 1 } },
      pro: { meterQuota: 500000, ratios: { default: 2 } },
    };
    mockBillingPlanRepository.findActive.mockResolvedValue(null);
    mockBillingPlanRepository.create.mockResolvedValue({});

    const result = await BillingPlanService.ensureSeeded();

    expect(result).toEqual({ seeded: 3, skipped: 0 });
    expect(mockBillingPlanRepository.findActive).toHaveBeenCalledTimes(3);
    expect(mockBillingPlanRepository.create).toHaveBeenCalledTimes(3);
    expect(mockBillingPlanRepository.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ planId: 'free', version: 'v1', meterQuota: 0, ratios: { default: 1 }, active: true }),
    );
  });

  test('meterMode=true with 3 planDefinitions and 1 existing seeds 2 and skips 1', async () => {
    mockConfig.billing.planDefinitions = {
      free: { meterQuota: 0, ratios: { default: 1 } },
      starter: { meterQuota: 50000, ratios: { default: 1 } },
      pro: { meterQuota: 500000, ratios: { default: 1 } },
    };
    mockBillingPlanRepository.findActive
      .mockResolvedValueOnce({ planId: 'free', version: 'v1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
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
});
