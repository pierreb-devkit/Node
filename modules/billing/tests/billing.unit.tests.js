/**
 * Module dependencies.
 */
import { jest } from '@jest/globals';
import config from '../../../config/index.js';
import schema from '../models/billing.subscription.schema.js';

/**
 * Unit tests
 */
describe('Billing unit tests:', () => {
  // rule 1 (Node#4020): pick a plan from the LOADED config instead of hardcoding
  // a devkit-default plan id ('pro'/'starter') — a consumer with a different plan
  // catalogue must still pass these SubscriptionUpdate assertions.
  const nonDefaultPlan = config.billing.plans.find((plan) => plan !== config.billing.defaultPlan) ?? config.billing.plans[0];

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

      const result = schema.Subscription.safeParse(subscription);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
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

    test('should not expose cancelAtPeriodEnd (delegated to Stripe API)', (done) => {
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.cancelAtPeriodEnd).toBeUndefined();
      done();
    });

    test('should strip unknown fields with SubscriptionUpdate', (done) => {
      const update = { plan: nonDefaultPlan, unknown: 'field' };
      const result = schema.SubscriptionUpdate.safeParse(update);
      expect(result.error).toBeFalsy();
      expect(result.data?.unknown).toBeUndefined();
      done();
    });

    test('should allow partial updates with SubscriptionUpdate', (done) => {
      const update = { plan: nonDefaultPlan };
      const result = schema.SubscriptionUpdate.safeParse(update);
      expect(result.error).toBeFalsy();
      expect(result.data.plan).toBe(nonDefaultPlan);
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
      const update = { plan: nonDefaultPlan };
      const result = schema.SubscriptionUpdate.safeParse(update);
      expect(result.error).toBeFalsy();
      expect(result.data.plan).toBe(nonDefaultPlan);
      expect(result.data.status).toBeUndefined();
      done();
    });
  });

  describe('Subscription schema — meter fields (backward compat)', () => {
    let subscription;

    beforeEach(() => {
      subscription = {
        organization: '507f1f77bcf86cd799439011',
        plan: 'free',
        status: 'active',
      };
    });

    test('should be valid without meter fields (non-meter downstream)', () => {
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
    });

    test('should accept planVersion as optional string', () => {
      subscription.planVersion = 'v2';
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.planVersion).toBe('v2');
    });

    test('should accept currentPeriodStart as a date', () => {
      subscription.currentPeriodStart = '2026-05-01T00:00:00.000Z';
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.currentPeriodStart).toBeInstanceOf(Date);
    });

    test('should accept currentPeriodStart as null', () => {
      subscription.currentPeriodStart = null;
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.currentPeriodStart).toBeNull();
    });

    test('should accept pastDueSince as a date', () => {
      subscription.pastDueSince = new Date('2026-05-10');
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.pastDueSince).toBeInstanceOf(Date);
    });

    test('should accept pastDueSince as null (no past-due event)', () => {
      subscription.pastDueSince = null;
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.pastDueSince).toBeNull();
    });

    test('SubscriptionUpdate should allow patching planVersion alone', () => {
      const update = { planVersion: 'v3' };
      const result = schema.SubscriptionUpdate.safeParse(update);
      expect(result.error).toBeFalsy();
      expect(result.data.planVersion).toBe('v3');
    });

    test('should accept lastSubscriptionEventId as optional string', () => {
      subscription.lastSubscriptionEventId = 'evt_1AbCdEf';
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.lastSubscriptionEventId).toBe('evt_1AbCdEf');
    });

    test('should accept lastSubscriptionEventId as null', () => {
      subscription.lastSubscriptionEventId = null;
      const result = schema.Subscription.safeParse(subscription);
      expect(result.error).toBeFalsy();
      expect(result.data.lastSubscriptionEventId).toBeNull();
    });
  });

  describe('ExtrasCheckoutRequest schema', () => {
    let request;

    beforeEach(() => {
      request = {
        packId: 'pack_500k',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      };
    });

    test('should be valid with all required fields', () => {
      const result = schema.ExtrasCheckoutRequest.safeParse(request);
      expect(result.error).toBeFalsy();
      expect(result.data.packId).toBe('pack_500k');
      expect(result.data.successUrl).toBe('https://example.com/success');
      expect(result.data.cancelUrl).toBe('https://example.com/cancel');
    });

    test('should reject when packId is empty', () => {
      request.packId = '';
      const result = schema.ExtrasCheckoutRequest.safeParse(request);
      expect(result.error).toBeDefined();
    });

    test('should reject when packId is missing', () => {
      delete request.packId;
      const result = schema.ExtrasCheckoutRequest.safeParse(request);
      expect(result.error).toBeDefined();
    });

    test('should reject when successUrl is not a valid URL', () => {
      request.successUrl = 'not-a-url';
      const result = schema.ExtrasCheckoutRequest.safeParse(request);
      expect(result.error).toBeDefined();
    });

    test('should reject when cancelUrl is not a valid URL', () => {
      request.cancelUrl = 'not-a-url';
      const result = schema.ExtrasCheckoutRequest.safeParse(request);
      expect(result.error).toBeDefined();
    });

    test('should trim whitespace from packId', () => {
      request.packId = '  pack_500k  ';
      const result = schema.ExtrasCheckoutRequest.safeParse(request);
      expect(result.error).toBeFalsy();
      expect(result.data.packId).toBe('pack_500k');
    });

    test('should reject unknown fields (strict)', () => {
      request.extraField = 'should not be here';
      const result = schema.ExtrasCheckoutRequest.safeParse(request);
      expect(result.error).toBeDefined();
    });

    test('should accept http:// URLs (for development environments)', () => {
      request.successUrl = 'http://localhost:3000/success';
      request.cancelUrl = 'http://localhost:3000/cancel';
      const result = schema.ExtrasCheckoutRequest.safeParse(request);
      expect(result.error).toBeFalsy();
    });

    test('should reject when successUrl is missing', () => {
      delete request.successUrl;
      const result = schema.ExtrasCheckoutRequest.safeParse(request);
      expect(result.error).toBeDefined();
    });

    test('should reject when cancelUrl is missing', () => {
      delete request.cancelUrl;
      const result = schema.ExtrasCheckoutRequest.safeParse(request);
      expect(result.error).toBeDefined();
    });
  });

  // rule 1 (Node#4020): the two SubscriptionUpdate fixes above prove the tests no
  // longer HARDCODE a devkit-default plan id, but they still run against the real
  // devkit-default catalogue (free/starter/pro/enterprise). This block proves the
  // schema itself is config-driven — not merely re-labeling the same default —
  // by rebuilding it against a synthetic consumer profile with a totally different
  // plan catalogue and confirming the enum follows the config, not a stack default.
  describe('Subscription schema — synthetic consumer plan catalogue:', () => {
    const syntheticPlans = ['launch', 'grow', 'scale'];
    const syntheticDefaultPlan = 'launch';
    let SyntheticSchema;

    beforeAll(async () => {
      jest.resetModules();
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          billing: {
            plans: syntheticPlans,
            defaultPlan: syntheticDefaultPlan,
            statuses: ['active', 'canceled'],
          },
        },
      }));
      SyntheticSchema = (await import('../models/billing.subscription.schema.js')).default;
    });

    afterAll(() => {
      jest.resetModules();
    });

    test('accepts every plan from the synthetic catalogue (none of which exist in the devkit default)', () => {
      for (const plan of syntheticPlans) {
        const result = SyntheticSchema.Subscription.safeParse({
          organization: '507f1f77bcf86cd799439011',
          plan,
          status: 'active',
        });
        expect(result.error).toBeFalsy();
      }
    });

    test('rejects a devkit-default plan id that is absent from the synthetic catalogue', () => {
      const result = SyntheticSchema.Subscription.safeParse({
        organization: '507f1f77bcf86cd799439011',
        plan: 'free',
        status: 'active',
      });
      expect(result.error).toBeDefined();
    });

    test('SubscriptionUpdate round-trips a synthetic-catalogue plan id', () => {
      const result = SyntheticSchema.SubscriptionUpdate.safeParse({ plan: syntheticPlans[1] });
      expect(result.error).toBeFalsy();
      expect(result.data.plan).toBe(syntheticPlans[1]);
    });
  });
});
