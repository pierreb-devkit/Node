import { describe, test, expect } from '@jest/globals';
import {
  PRICING_VERSION,
  PLAN_QUOTAS,
  RATIOS,
  STRIPE_PRICE_CENTS,
  STRIPE_PACK_CENTS,
} from '../../../config/defaults/billing.pricing.constants.js';

describe('billing.pricing.constants — devkit contract:', () => {
  test('PRICING_VERSION is the safe default 0.0.0', () => {
    expect(PRICING_VERSION).toBe('0.0.0');
  });
  test('PLAN_QUOTAS is the safe default { free: 0 }', () => {
    expect(PLAN_QUOTAS).toEqual({ free: 0 });
  });
  test('RATIOS is the safe default empty object', () => {
    expect(RATIOS).toEqual({});
  });
  test('STRIPE_PRICE_CENTS is the safe default empty object', () => {
    expect(STRIPE_PRICE_CENTS).toEqual({});
  });
  test('STRIPE_PACK_CENTS is the safe default empty object', () => {
    expect(STRIPE_PACK_CENTS).toEqual({});
  });
});
