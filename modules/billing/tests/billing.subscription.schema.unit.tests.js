/**
 * Module dependencies.
 */
import schema from '../models/billing.subscription.schema.js';

/**
 * Unit tests — cancelAtPeriodEnd + cancelAt lifecycle fields
 */
describe('Billing subscription schema — cancelAt lifecycle fields:', () => {
  let subscription;

  beforeEach(() => {
    subscription = {
      organization: '507f1f77bcf86cd799439011',
      plan: 'free',
      status: 'active',
    };
  });

  describe('cancelAtPeriodEnd', () => {
    test('should accept true', () => {
      subscription.cancelAtPeriodEnd = true;
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAtPeriodEnd).toBe(true);
    });

    test('should accept false', () => {
      subscription.cancelAtPeriodEnd = false;
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAtPeriodEnd).toBe(false);
    });

    test('should be optional (omitted → undefined)', () => {
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAtPeriodEnd).toBeUndefined();
    });

    test('should reject a string value', () => {
      subscription.cancelAtPeriodEnd = 'yes';
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeDefined();
    });

    test('should reject a number value', () => {
      subscription.cancelAtPeriodEnd = 1;
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeDefined();
    });

    test('SubscriptionUpdate should allow patching cancelAtPeriodEnd alone', () => {
      const update = { cancelAtPeriodEnd: true };
      const result = schema.SubscriptionUpdate.safeParse(update);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAtPeriodEnd).toBe(true);
    });
  });

  describe('cancelAt', () => {
    test('should accept a Date object', () => {
      subscription.cancelAt = new Date('2026-06-30T00:00:00.000Z');
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAt).toBeInstanceOf(Date);
    });

    test('should coerce an ISO string to Date', () => {
      subscription.cancelAt = '2026-06-30T00:00:00.000Z';
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAt).toBeInstanceOf(Date);
      expect(result.data.cancelAt.toISOString()).toBe('2026-06-30T00:00:00.000Z');
    });

    test('should coerce a Number to Date (z.coerce.date treats numbers as ms, not seconds)', () => {
      // z.coerce.date() treats numbers as MILLISECONDS — Stripe's cancel_at is Unix seconds.
      // The webhook handler (C.2) must multiply by 1000: new Date(stripeEvent.cancel_at * 1000).
      // This test confirms the schema accepts a number and coerces to Date (whatever the value).
      subscription.cancelAt = 1751241600 * 1000; // ms → correct date: 2025-06-30
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAt).toBeInstanceOf(Date);
      expect(result.data.cancelAt.toISOString()).toBe('2025-06-30T00:00:00.000Z');
    });

    test('should accept null (no pending cancellation)', () => {
      subscription.cancelAt = null;
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAt).toBeNull();
    });

    test('should be optional (omitted → undefined)', () => {
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAt).toBeUndefined();
    });

    test('SubscriptionUpdate should allow patching cancelAt alone', () => {
      const update = { cancelAt: '2026-07-15T00:00:00.000Z' };
      const result = schema.SubscriptionUpdate.safeParse(update);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAt).toBeInstanceOf(Date);
    });
  });

  describe('both fields together', () => {
    test('should accept both fields populated (pending cancel state)', () => {
      subscription.cancelAtPeriodEnd = true;
      subscription.cancelAt = '2026-06-30T00:00:00.000Z';
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAtPeriodEnd).toBe(true);
      expect(result.data.cancelAt).toBeInstanceOf(Date);
    });

    test('should reject null cancelAtPeriodEnd (not nullable — use undefined/omit to clear)', () => {
      // cancelAtPeriodEnd is z.boolean().optional(), NOT .nullable().
      // Passing null is rejected — callers must omit the field or pass true/false.
      // cancelAt IS nullable (z.coerce.date().nullable().optional()) so null passes for it.
      subscription.cancelAtPeriodEnd = null;
      subscription.cancelAt = null;
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeDefined();
    });

    test('should accept cancelAt null + cancelAtPeriodEnd false (cancel revoked)', () => {
      subscription.cancelAtPeriodEnd = false;
      subscription.cancelAt = null;
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAtPeriodEnd).toBe(false);
      expect(result.data.cancelAt).toBeNull();
    });
  });
});
