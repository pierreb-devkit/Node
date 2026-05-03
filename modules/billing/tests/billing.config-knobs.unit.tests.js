/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

describe('billing config knob helpers:', () => {
  let mockConfig;
  let constants;

  beforeEach(async () => {
    jest.resetModules();
    mockConfig = {
      billing: {
        plans: ['free', 'pro'],
        meter: {
          runBase: 9,
          runBaseUnits: 3,
          fallbackPlanId: 'enterprise',
        },
        outbox: {
          maxRetryAttempts: 7,
          retryIntervalSec: 42,
        },
        crons: {
          jitterMaxMs: 1234,
        },
        planChange: {
          preserveUsageDefault: false,
        },
        alerts: {
          thresholdPercents: [95, 50],
        },
        events: {
          extrasExhausted: 'billing.custom.exhausted',
        },
      },
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    constants = await import('../lib/billing.constants.js');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('reads explicit billing hardening config overrides', () => {
    expect(constants.getMeterRunBase()).toBe(9);
    expect(constants.getMeterFallbackPlanId()).toBe('enterprise');
    expect(constants.getOutboxMaxRetryAttempts()).toBe(7);
    expect(constants.getOutboxRetryIntervalMs()).toBe(42_000);
    expect(constants.getCronJitterMaxMs()).toBe(1234);
    expect(constants.getPlanChangePreserveUsageDefault()).toBe(false);
    expect(constants.getAlertThresholdPercents()).toEqual([95, 50]);
    expect(constants.getExtrasExhaustedEventName()).toBe('billing.custom.exhausted');
  });

  test('getDollarsToUnitRatio reads from config', () => {
    mockConfig.billing.meter.dollarsToUnitRatio = 500;
    expect(constants.getDollarsToUnitRatio()).toBe(500);
  });

  test('getDollarsToUnitRatio defaults to 1000', async () => {
    mockConfig.billing = {};
    expect(constants.getDollarsToUnitRatio()).toBe(1000);
  });

  test('getMaxUnitsPerOperation reads from config', () => {
    mockConfig.billing.meter.maxUnitsPerOperation = 25000;
    expect(constants.getMaxUnitsPerOperation()).toBe(25000);
  });

  test('getMaxUnitsPerOperation defaults to Infinity', async () => {
    mockConfig.billing = {};
    expect(constants.getMaxUnitsPerOperation()).toBe(Infinity);
  });

  test('getDefaultPlanId reads from config', () => {
    mockConfig.billing.defaultPlan = 'starter';
    expect(constants.getDefaultPlanId()).toBe('starter');
  });

  test('getDefaultPlanId defaults to free', async () => {
    mockConfig.billing = {};
    expect(constants.getDefaultPlanId()).toBe('free');
  });

  test('keeps backward-compatible defaults and runBaseUnits alias', async () => {
    mockConfig.billing = {
      plans: ['free'],
      meter: {
        runBaseUnits: 4,
      },
    };

    expect(constants.getMeterRunBase()).toBe(4);
    expect(constants.getMeterFallbackPlanId()).toBe('free');
    expect(constants.getOutboxMaxRetryAttempts()).toBe(5);
    expect(constants.getOutboxRetryIntervalMs()).toBe(300_000);
    expect(constants.getCronJitterMaxMs()).toBe(60_000);
    expect(constants.getPlanChangePreserveUsageDefault()).toBe(true);
    expect(constants.getAlertThresholdPercents()).toEqual([100, 80]);
    expect(constants.getExtrasExhaustedEventName()).toBe('billing.extras_debit.exhausted');
    expect(constants.getDollarsToUnitRatio()).toBe(1000);
    expect(constants.getMaxUnitsPerOperation()).toBe(Infinity);
    expect(constants.getDefaultPlanId()).toBe('free');
  });
});
