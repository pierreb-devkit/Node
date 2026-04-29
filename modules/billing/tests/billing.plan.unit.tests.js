/**
 * Module dependencies.
 */
import { describe, test, beforeEach, expect } from '@jest/globals';
import schema from '../models/billing.plan.schema.js';

/**
 * Unit tests for BillingPlan schema
 */
describe('BillingPlan unit tests:', () => {
  describe('Schema validation — BillingPlan', () => {
    let plan;

    beforeEach(() => {
      plan = {
        planId: 'pro',
        version: 'v1',
        meterQuota: 500000,
        effectiveFrom: new Date('2026-05-01'),
      };
    });

    test('should be valid with required fields only', () => {
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeFalsy();
      expect(result.data.planId).toBe('pro');
      expect(result.data.version).toBe('v1');
      expect(result.data.meterQuota).toBe(500000);
      expect(result.data.active).toBe(true);
    });

    test('should default active to true', () => {
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeFalsy();
      expect(result.data.active).toBe(true);
    });

    test('should default ratios to empty object', () => {
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeFalsy();
      expect(result.data.ratios).toEqual({});
    });

    test('should accept custom ratios', () => {
      plan.ratios = { scrap: 1, autofix: 2, wizard: 5 };
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeFalsy();
      expect(result.data.ratios.scrap).toBe(1);
      expect(result.data.ratios.wizard).toBe(5);
    });

    test('should reject negative ratio values', () => {
      plan.ratios = { scrap: -1 };
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeDefined();
    });

    test('should reject missing planId', () => {
      delete plan.planId;
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeDefined();
    });

    test('should reject empty planId', () => {
      plan.planId = '';
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeDefined();
    });

    test('should reject missing version', () => {
      delete plan.version;
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeDefined();
    });

    test('should reject negative meterQuota', () => {
      plan.meterQuota = -1;
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeDefined();
    });

    test('should accept zero meterQuota (free plan)', () => {
      plan.meterQuota = 0;
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeFalsy();
      expect(result.data.meterQuota).toBe(0);
    });

    test('should accept optional stripe price IDs', () => {
      plan.stripePriceMonthly = 'price_monthly_xxx';
      plan.stripePriceAnnual = 'price_annual_yyy';
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeFalsy();
      expect(result.data.stripePriceMonthly).toBe('price_monthly_xxx');
      expect(result.data.stripePriceAnnual).toBe('price_annual_yyy');
    });

    test('should accept effectiveUntil as null', () => {
      plan.effectiveUntil = null;
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeFalsy();
      expect(result.data.effectiveUntil).toBeNull();
    });

    test('should accept effectiveUntil as a date', () => {
      plan.effectiveUntil = new Date('2027-01-01');
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeFalsy();
      expect(result.data.effectiveUntil).toBeInstanceOf(Date);
    });

    test('should coerce string date to Date for effectiveFrom', () => {
      plan.effectiveFrom = '2026-05-01T00:00:00.000Z';
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeFalsy();
      expect(result.data.effectiveFrom).toBeInstanceOf(Date);
    });

    test('should reject missing effectiveFrom', () => {
      delete plan.effectiveFrom;
      const result = schema.BillingPlan.safeParse(plan);
      expect(result.error).toBeDefined();
    });
  });

  describe('Schema validation — BillingPlanBump', () => {
    let bump;

    beforeEach(() => {
      bump = {
        meterQuota: 1000000,
      };
    });

    test('should be valid with only meterQuota', () => {
      const result = schema.BillingPlanBump.safeParse(bump);
      expect(result.error).toBeFalsy();
      expect(result.data.meterQuota).toBe(1000000);
    });

    test('should accept ratios override', () => {
      bump.ratios = { scrap: 2, wizard: 10 };
      const result = schema.BillingPlanBump.safeParse(bump);
      expect(result.error).toBeFalsy();
      expect(result.data.ratios.scrap).toBe(2);
    });

    test('should reject negative ratio values in bump (matches BillingPlan contract)', () => {
      bump.ratios = { scrap: -1 };
      const result = schema.BillingPlanBump.safeParse(bump);
      expect(result.error).toBeDefined();
    });

    test('should reject extra unknown fields (strict)', () => {
      bump.unknownField = 'should fail';
      const result = schema.BillingPlanBump.safeParse(bump);
      expect(result.error).toBeDefined();
    });

    test('should reject negative meterQuota', () => {
      bump.meterQuota = -500;
      const result = schema.BillingPlanBump.safeParse(bump);
      expect(result.error).toBeDefined();
    });

    test('should reject missing meterQuota', () => {
      delete bump.meterQuota;
      const result = schema.BillingPlanBump.safeParse(bump);
      expect(result.error).toBeDefined();
    });
  });
});
