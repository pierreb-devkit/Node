import { describe, test, expect } from '@jest/globals';
import defaults from '../../../config/defaults/development.config.js';

describe('config.billing.pricing wiring (development.config.js):', () => {
  test('exposes PRICING_VERSION, PLAN_QUOTAS, RATIOS, STRIPE_PRICE_CENTS, STRIPE_PACK_CENTS', () => {
    expect(defaults.billing).toBeDefined();
    expect(defaults.billing.pricing).toBeDefined();
    expect(defaults.billing.pricing.PRICING_VERSION).toBeDefined();
    expect(defaults.billing.pricing.PLAN_QUOTAS).toBeDefined();
    expect(defaults.billing.pricing.RATIOS).toBeDefined();
    expect(defaults.billing.pricing.STRIPE_PRICE_CENTS).toBeDefined();
    expect(defaults.billing.pricing.STRIPE_PACK_CENTS).toBeDefined();
  });
  test('PLAN_QUOTAS has at least `free` numeric entry by default', () => {
    expect(typeof defaults.billing.pricing.PLAN_QUOTAS.free).toBe('number');
  });
});
