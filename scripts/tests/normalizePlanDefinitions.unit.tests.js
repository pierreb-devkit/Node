/**
 * Module dependencies.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

/**
 * Unit tests for normalizePlanDefinitions (billing planDefinitions shim).
 */
describe('normalizePlanDefinitions unit tests:', () => {
  let normalizePlanDefinitions;
  let warnSpy;

  beforeEach(async () => {
    jest.resetModules();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Import the named export directly from config/index.js.
    // config/index.js is a top-level ESM module with a top-level await — jest.resetModules()
    // causes a fresh evaluation each time, which is fine for unit-testing the named export.
    const mod = await import('../../config/index.js');
    normalizePlanDefinitions = mod.normalizePlanDefinitions;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns null unchanged', () => {
    expect(normalizePlanDefinitions(null)).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('returns undefined unchanged', () => {
    expect(normalizePlanDefinitions(undefined)).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('returns array input as-is (no conversion, no warning)', () => {
    const input = [
      { planId: 'free', meterQuota: 0, ratios: { default: 1 } },
      { planId: 'pro', meterQuota: 500000, ratios: { default: 1 } },
    ];
    const result = normalizePlanDefinitions(input);
    expect(result).toBe(input); // same reference — no copy
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('converts legacy object shape to array form and emits deprecation warning', () => {
    const legacy = {
      free: { meterQuota: 0, ratios: { default: 1 } },
      starter: { meterQuota: 50000, ratios: { default: 1 } },
      pro: { meterQuota: 500000, ratios: { default: 2 } },
    };

    const result = normalizePlanDefinitions(legacy);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ planId: 'free', meterQuota: 0, ratios: { default: 1 } });
    expect(result[1]).toEqual({ planId: 'starter', meterQuota: 50000, ratios: { default: 1 } });
    expect(result[2]).toEqual({ planId: 'pro', meterQuota: 500000, ratios: { default: 2 } });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[billing] planDefinitions object shape is deprecated'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('2026-05-01-billing-plan-definitions-array.md'),
    );
  });

  test('planId is correctly extracted as its own field (not nested under planId key)', () => {
    const legacy = {
      enterprise: { meterQuota: 2000000, ratios: { default: 1 } },
    };

    const [entry] = normalizePlanDefinitions(legacy);

    expect(entry.planId).toBe('enterprise');
    expect(entry.meterQuota).toBe(2000000);
    // planId should not be doubled/nested
    expect(entry).not.toHaveProperty('enterprise');
  });
});
