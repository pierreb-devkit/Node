/**
 * Module dependencies.
 */
import { jest, describe, it, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for planDefinitions config shape — validates signupGrant / oneShot fields.
 */
describe('billing planDefinitions config:', () => {
  let config;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('../../../config/index.js');
    config = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('planDefinitions — Free signup grant', () => {
    it('Free plan has signupGrant: 500 and oneShot: true', () => {
      const definitions = config?.billing?.planDefinitions ?? [];
      const free = definitions.find((p) => p.planId === 'free');
      expect(free).toBeDefined();
      expect(free.signupGrant).toBe(500);
      expect(free.oneShot).toBe(true);
      expect(free.meterQuota).toBe(0);
    });

    it('Growth and Pro plans do not have signupGrant', () => {
      const definitions = config?.billing?.planDefinitions ?? [];
      const growth = definitions.find((p) => p.planId === 'growth');
      const pro = definitions.find((p) => p.planId === 'pro');
      if (growth) expect(growth.signupGrant).toBeUndefined();
      if (pro) expect(pro.signupGrant).toBeUndefined();
    });

    it('Free plan signupGrant is a non-negative integer', () => {
      const definitions = config?.billing?.planDefinitions ?? [];
      const free = definitions.find((p) => p.planId === 'free');
      expect(free).toBeDefined();
      expect(Number.isInteger(free.signupGrant)).toBe(true);
      expect(free.signupGrant).toBeGreaterThanOrEqual(0);
    });

    it('Free plan oneShot is a boolean', () => {
      const definitions = config?.billing?.planDefinitions ?? [];
      const free = definitions.find((p) => p.planId === 'free');
      expect(free).toBeDefined();
      expect(typeof free.oneShot).toBe('boolean');
    });
  });

  describe('planDefinitions Zod schema validation', () => {
    it('validates a plan entry with signupGrant and oneShot via billingPlanDefinitionSchema', async () => {
      const { billingPlanDefinitionSchema } = await import('../config/billing.config.zod.js');
      const result = billingPlanDefinitionSchema.safeParse({
        planId: 'free',
        meterQuota: 0,
        signupGrant: 500,
        oneShot: true,
        ratios: { default: 1 },
      });
      expect(result.success).toBe(true);
    });

    it('validates a plan entry without signupGrant and oneShot (optional fields)', async () => {
      const { billingPlanDefinitionSchema } = await import('../config/billing.config.zod.js');
      const result = billingPlanDefinitionSchema.safeParse({
        planId: 'growth',
        meterQuota: 1600,
        ratios: { default: 1 },
      });
      expect(result.success).toBe(true);
    });

    it('rejects negative signupGrant', async () => {
      const { billingPlanDefinitionSchema } = await import('../config/billing.config.zod.js');
      const result = billingPlanDefinitionSchema.safeParse({
        planId: 'free',
        meterQuota: 0,
        signupGrant: -1,
        ratios: {},
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer signupGrant', async () => {
      const { billingPlanDefinitionSchema } = await import('../config/billing.config.zod.js');
      const result = billingPlanDefinitionSchema.safeParse({
        planId: 'free',
        meterQuota: 0,
        signupGrant: 500.5,
        ratios: {},
      });
      expect(result.success).toBe(false);
    });
  });
});
