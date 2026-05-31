/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.init — boot validators.
 */
describe('billing.init unit tests:', () => {
  let billingInit;
  let mockBillingUsageRepository;
  let mockConfig;
  let mockDistinct;
  let mockMongoose;
  let mockLogger;

  const mockApp = {};

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: false,
        packs: [],
      },
    };

    mockBillingUsageRepository = {
      countLegacyConsumedHistoryIds: jest.fn().mockResolvedValue(0),
    };

    mockDistinct = jest.fn().mockResolvedValue([]);
    mockMongoose = {
      model: jest.fn().mockReturnValue({ distinct: mockDistinct }),
    };

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../repositories/billing.usage.repository.js', () => ({
      default: mockBillingUsageRepository,
    }));

    // Stub analytics, logger and events to avoid side effects
    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { groupIdentify: jest.fn() },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: mockLogger,
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { on: jest.fn(), emit: jest.fn() },
    }));

    // Stub billing.email so boot validator tests don't wire real email listeners
    jest.unstable_mockModule('../billing.email.js', () => ({
      setupBillingEmails: jest.fn(),
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

  test('resolves without error when meterMode=false', async () => {
    await expect(billingInit(mockApp)).resolves.toBeUndefined();
  });

  test('resolves without error when meterMode=true and no legacy docs', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.plans = ['free', 'growth', 'pro'];

    await expect(billingInit(mockApp)).resolves.toBeUndefined();
  });

  test('boot validator warns on orphaned Subscription.plan values when meterMode=true', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.plans = ['free', 'starter', 'pro'];

    mockDistinct.mockResolvedValue(['free', 'legacy_plan']);

    await billingInit(mockApp);

    expect(mockDistinct).toHaveBeenCalledWith('plan');
    // After Batch 4 item 6: uses logger.warn instead of console.warn
    const warnCalls = mockLogger.warn.mock.calls.map((c) => c[0]);
    expect(warnCalls.some((w) => w.includes('"legacy_plan" not in planDefinitions'))).toBe(true);
    expect(warnCalls.some((w) => w.includes('"free"'))).toBe(false);
  });

  test('meterMode=true aborts boot when legacy consumedHistoryIds fields remain', async () => {
    mockConfig.billing.meterMode = true;
    mockBillingUsageRepository.countLegacyConsumedHistoryIds.mockResolvedValue(2);

    await expect(billingInit(mockApp)).rejects.toThrow('legacy consumedHistoryIds field still present');
  });

  test('warns at boot when thresholdPercents contains unsupported value (not 80/100)', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.alerts = { thresholdPercents: [75] };
    mockConfig.billing.plans = ['free'];

    await billingInit(mockApp);

    // After Batch 4 item 6: uses logger.warn instead of console.warn
    const warnCalls = mockLogger.warn.mock.calls.map((c) => c[0]);
    expect(warnCalls.some((w) => w.includes('75%') && w.includes('silently skipped'))).toBe(true);
  });

  test('does not warn at boot when thresholdPercents contains only supported values', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.alerts = { thresholdPercents: [80, 100] };
    mockConfig.billing.plans = ['free'];

    await billingInit(mockApp);

    const warnCalls = mockLogger.warn.mock.calls.map((c) => c[0]);
    expect(warnCalls.some((w) => typeof w === 'string' && w.includes('silently skipped'))).toBe(false);
  });

  test('does not warn at boot for threshold validation when meterMode=false', async () => {
    mockConfig.billing.meterMode = false;
    mockConfig.billing.alerts = { thresholdPercents: [75] };

    await billingInit(mockApp);

    const warnCalls = mockLogger.warn.mock.calls.map((c) => c[0]);
    expect(warnCalls.some((w) => typeof w === 'string' && w.includes('silently skipped'))).toBe(false);
  });

  test('boot validator failure does not crash boot', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.plans = ['free'];

    mockMongoose.model.mockImplementation(() => {
      throw new Error('model not registered');
    });

    await expect(billingInit(mockApp)).resolves.toBeUndefined();
  });
});
