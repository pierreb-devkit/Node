/**
 * Module dependencies.
 */
import config from '../../../config/index.js';
import schema from '../models/billing.subscription.schema.js';

/**
 * Unit tests
 */
describe('Billing unit tests:', () => {
  describe('Subscription schema', () => {
    let subscription;

    beforeEach(() => {
      subscription = {
        organization: '507f1f77bcf86cd799439011',
        plan: 'free',
        status: 'active',
      };
    });

    test('should be valid a subscription example without problems', (done) => {
      const result = schema.Subscription.safeParse(subscription);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should be able to show an error when trying a schema without organization', (done) => {
      subscription.organization = '';

      const result = schema.Subscription.safeParse(subscription);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should be valid with all optional fields', (done) => {
      subscription.stripeCustomerId = 'cus_123';
      subscription.stripeSubscriptionId = 'sub_456';
      subscription.currentPeriodEnd = '2026-12-31T00:00:00.000Z';
      subscription.cancelAtPeriodEnd = true;

      const result = schema.Subscription.safeParse(subscription);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAtPeriodEnd).toBe(true);
      done();
    });

    test('should default plan to free', (done) => {
      delete subscription.plan;

      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.plan).toBe('free');
      done();
    });

    test('should default status to active', (done) => {
      delete subscription.status;

      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.status).toBe('active');
      done();
    });

    test('should reject invalid plan value', (done) => {
      subscription.plan = 'invalid';

      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject invalid status value', (done) => {
      subscription.status = 'invalid';

      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeDefined();
      done();
    });

    test('should accept all valid plan values', (done) => {
      for (const plan of config.billing.plans) {
        subscription.plan = plan;
        const result = schema.Subscription.safeParse(subscription);
        expect(result.error).toBeFalsy();
      }
      done();
    });

    test('should accept all valid status values', (done) => {
      for (const status of config.billing.statuses) {
        subscription.status = status;
        const result = schema.Subscription.safeParse(subscription);
        expect(result.error).toBeFalsy();
      }
      done();
    });

    test('should default cancelAtPeriodEnd to false', (done) => {
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAtPeriodEnd).toBe(false);
      done();
    });

    test('should strip unknown fields with SubscriptionUpdate', (done) => {
      const update = { plan: 'pro', unknown: 'field' };
      const result = schema.SubscriptionUpdate.safeParse(update);
      expect(result.error).toBeFalsy();
      expect(result.data?.unknown).toBeUndefined();
      done();
    });

    test('should allow partial updates with SubscriptionUpdate', (done) => {
      const update = { plan: 'starter' };
      const result = schema.SubscriptionUpdate.safeParse(update);
      expect(result.error).toBeFalsy();
      expect(result.data.plan).toBe('starter');
      done();
    });

    test('should reject invalid ObjectId for organization', (done) => {
      subscription.organization = 'not-an-objectid';

      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeDefined();
      done();
    });

    test('should accept valid ObjectId for organization', (done) => {
      subscription.organization = '507f1f77bcf86cd799439011';

      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      done();
    });

    test('should normalize empty stripeCustomerId to undefined', (done) => {
      subscription.stripeCustomerId = '';

      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.stripeCustomerId).toBeUndefined();
      done();
    });

    test('should normalize empty stripeSubscriptionId to undefined', (done) => {
      subscription.stripeSubscriptionId = '';

      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.stripeSubscriptionId).toBeUndefined();
      done();
    });

    test('should preserve valid stripeCustomerId', (done) => {
      subscription.stripeCustomerId = 'cus_abc123';

      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.stripeCustomerId).toBe('cus_abc123');
      done();
    });

    test('should preserve valid stripeSubscriptionId', (done) => {
      subscription.stripeSubscriptionId = 'sub_xyz789';

      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.stripeSubscriptionId).toBe('sub_xyz789');
      done();
    });

    test('should not inject defaults in SubscriptionUpdate partial', (done) => {
      const update = { plan: 'pro' };
      const result = schema.SubscriptionUpdate.safeParse(update);
      expect(result.error).toBeFalsy();
      expect(result.data.plan).toBe('pro');
      expect(result.data.status).toBeUndefined();
      expect(result.data.cancelAtPeriodEnd).toBeUndefined();
      done();
    });
  });
});
