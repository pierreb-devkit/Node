import { describe, test, expect } from '@jest/globals';
import {
  PRICING_VERSION,
  PLAN_QUOTAS,
  RATIOS,
  STRIPE_PRICE_CENTS,
  STRIPE_PACK_CENTS,
} from '../../../config/defaults/billing.pricing.constants.js';

describe('billing.pricing.constants — devkit contract:', () => {
  test('PRICING_VERSION is a non-empty string with YYYY.MM shape (or 0.0.0 default)', () => {
    expect(typeof PRICING_VERSION).toBe('string');
    expect(PRICING_VERSION).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });
  test('PLAN_QUOTAS is an object with at least `free` key (numeric)', () => {
    expect(typeof PLAN_QUOTAS).toBe('object');
    expect(typeof PLAN_QUOTAS.free).toBe('number');
  });
  test('RATIOS is an object (may be empty by default)', () => {
    expect(typeof RATIOS).toBe('object');
  });
  test('STRIPE_PRICE_CENTS is an object (may be empty by default)', () => {
    expect(typeof STRIPE_PRICE_CENTS).toBe('object');
  });
  test('STRIPE_PACK_CENTS is an object (may be empty by default)', () => {
    expect(typeof STRIPE_PACK_CENTS).toBe('object');
  });
});
