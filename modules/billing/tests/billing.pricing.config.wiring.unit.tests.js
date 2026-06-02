import { describe, test, expect } from '@jest/globals';
import config from '../../../config/index.js';

describe('config.billing.pricing wiring:', () => {
  test('exposes PRICING_VERSION, PLAN_QUOTAS, RATIOS, STRIPE_PRICE_CENTS, STRIPE_PACK_CENTS', () => {
    expect(config.billing).toBeDefined();
    expect(config.billing.pricing).toBeDefined();
    expect(config.billing.pricing.PRICING_VERSION).toBeDefined();
    expect(config.billing.pricing.PLAN_QUOTAS).toBeDefined();
    expect(config.billing.pricing.RATIOS).toBeDefined();
    expect(config.billing.pricing.STRIPE_PRICE_CENTS).toBeDefined();
    expect(config.billing.pricing.STRIPE_PACK_CENTS).toBeDefined();
  });
  test('PLAN_QUOTAS has at least `free` numeric entry by default', () => {
    expect(typeof config.billing.pricing.PLAN_QUOTAS.free).toBe('number');
  });
});
