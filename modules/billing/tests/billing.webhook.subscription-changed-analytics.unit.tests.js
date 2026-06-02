/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for subscription_changed analytics emit in billing.webhook.service.js
 *   - captures when plan changes and AnalyticsService is configured
 *   - no-op when AnalyticsService.isConfigured() returns false (no PostHog)
 *   - no capture when plan did not change
 */
describe('billing.webhook.service — subscription_changed analytics emit:', () => {
  let BillingWebhookService;
  let mockAnalyticsCapture;
  let mockAnalyticsIsConfigured;
  let mockSubscriptionRepository;
  let mockOrganizationRepository;
  let mockResetService;
  let mockEvents;
  let mockStripe;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';

  const _mkStripeSubscription = (overrides = {}) => ({
    id: 'sub_456',
    status: 'active',
    customer: 'cus_abc',
    current_period_start: 1700000000,
    current_period_end: 1700000000 + 2592000,
    cancel_at_period_end: false,
    items: {
      data: [{
        price: { id: 'price_growth', metadata: { planId: 'growth' } },
        current_period_start: 1700000000,
      }],
    },
    ...overrides,
  });

  const _mkEvent = (overrides = {}) => ({
    id: 'evt_test_1',
    type: 'customer.subscription.updated',
    created: 1700000100,
    data: { previous_attributes: {} },
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockAnalyticsCapture = jest.fn();
    mockAnalyticsIsConfigured = jest.fn().mockReturnValue(true);

    mockSubscriptionRepository = {
      findByStripeSubscriptionId: jest.fn().mockResolvedValue({
        _id: subId,
        organization: orgId,
        plan: 'free',
      }),
      findByStripeCustomerId: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      updateIfEventNewer: jest.fn().mockResolvedValue({ _id: subId }),
    };

    mockOrganizationRepository = {
      setPlan: jest.fn().mockResolvedValue({}),
    };

    mockResetService = {
      resetWeek: jest.fn().mockResolvedValue({}),
      forceRotateForPlanChange: jest.fn().mockResolvedValue({}),
    };

    mockEvents = { emit: jest.fn() };

    mockStripe = {
      subscriptions: { retrieve: jest.fn() },
    };

    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: {
        capture: mockAnalyticsCapture,
        isConfigured: mockAnalyticsIsConfigured,
      },
    }));

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: {
        wasProcessed: jest.fn().mockResolvedValue(false),
        tryRecord: jest.fn().mockResolvedValue({ recorded: true }),
      },
    }));

    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: mockOrganizationRepository,
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: { creditPack: jest.fn(), refundPartial: jest.fn() },
    }));

    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({
      default: mockResetService,
    }));

    jest.unstable_mockModule('../lib/stripe.js', () => ({
      default: jest.fn(() => mockStripe),
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: mockEvents,
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: {
          plans: ['free', 'growth', 'pro'],
          meterMode: true,
        },
      },
    }));

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: () => ({}),
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when plan changes and AnalyticsService is configured', () => {
    test('captures subscription_changed with previousPlan, newPlan, isDowngrade', async () => {
      // existing sub has free plan, event carries growth plan → plan change
      await BillingWebhookService.handleSubscriptionUpdated(
        _mkStripeSubscription({
          items: {
            data: [{ price: { id: 'price_growth', metadata: { planId: 'growth' } }, current_period_start: 1700000000 }],
          },
        }),
        _mkEvent({
          data: {
            previous_attributes: {
              items: { data: [{ price: { id: 'price_free', metadata: { planId: 'free' } } }] },
            },
          },
        }),
      );

      expect(mockAnalyticsIsConfigured).toHaveBeenCalled();
      const subscriptionChangedCalls = mockAnalyticsCapture.mock.calls.filter(
        ([arg]) => arg.event === 'subscription_changed',
      );
      expect(subscriptionChangedCalls).toHaveLength(1);
      const [call] = subscriptionChangedCalls;
      expect(call[0].distinctId).toBe(orgId);
      expect(call[0].source).toBe('stripe-webhook');
      expect(call[0].properties).toMatchObject({
        previousPlan: 'free',
        newPlan: 'growth',
        isDowngrade: false,
      });
    });

    test('marks isDowngrade=true when switching from higher to lower plan', async () => {
      await BillingWebhookService.handleSubscriptionUpdated(
        _mkStripeSubscription({
          items: {
            data: [{ price: { id: 'price_free', metadata: { planId: 'free' } }, current_period_start: 1700000000 }],
          },
        }),
        _mkEvent({
          data: {
            previous_attributes: {
              items: { data: [{ price: { id: 'price_pro', metadata: { planId: 'pro' } } }] },
            },
          },
        }),
      );

      const subscriptionChangedCalls = mockAnalyticsCapture.mock.calls.filter(
        ([arg]) => arg.event === 'subscription_changed',
      );
      expect(subscriptionChangedCalls).toHaveLength(1);
      expect(subscriptionChangedCalls[0][0].properties.isDowngrade).toBe(true);
    });
  });

  describe('when AnalyticsService is not configured (no PostHog)', () => {
    test('does not capture subscription_changed (clean no-op)', async () => {
      mockAnalyticsIsConfigured.mockReturnValue(false);

      await BillingWebhookService.handleSubscriptionUpdated(
        _mkStripeSubscription({
          items: {
            data: [{ price: { id: 'price_growth', metadata: { planId: 'growth' } }, current_period_start: 1700000000 }],
          },
        }),
        _mkEvent({
          data: {
            previous_attributes: {
              items: { data: [{ price: { id: 'price_free', metadata: { planId: 'free' } } }] },
            },
          },
        }),
      );

      expect(mockAnalyticsCapture).not.toHaveBeenCalled();
    });
  });

  describe('when plan did not change', () => {
    test('does not capture subscription_changed when previous_attributes.items is absent', async () => {
      // No previous_attributes.items — plan-change branch is skipped entirely
      await BillingWebhookService.handleSubscriptionUpdated(
        _mkStripeSubscription(),
        _mkEvent({
          data: { previous_attributes: {} },
        }),
      );

      const subscriptionChangedCalls = mockAnalyticsCapture.mock.calls.filter(
        ([arg]) => arg.event === 'subscription_changed',
      );
      expect(subscriptionChangedCalls).toHaveLength(0);
    });

    test('does not capture subscription_changed when previousPlan === newPlan (same-plan guard)', async () => {
      // previous_attributes.items IS present but the plan is the same — the
      // `previousPlan !== newPlan` guard should prevent the emit.
      await BillingWebhookService.handleSubscriptionUpdated(
        _mkStripeSubscription({
          items: {
            data: [{ price: { id: 'price_growth', metadata: { planId: 'growth' } }, current_period_start: 1700000000 }],
          },
        }),
        _mkEvent({
          data: {
            previous_attributes: {
              items: { data: [{ price: { id: 'price_growth', metadata: { planId: 'growth' } } }] },
            },
          },
        }),
      );

      const subscriptionChangedCalls = mockAnalyticsCapture.mock.calls.filter(
        ([arg]) => arg.event === 'subscription_changed',
      );
      expect(subscriptionChangedCalls).toHaveLength(0);
    });
  });

  describe('when event is stale (updateIfEventNewer returns null)', () => {
    test('does not capture subscription_changed', async () => {
      // Fixture includes previous_attributes.items so the stale-event guard is what
      // actually prevents capture (not the absence of a plan change).
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue(null);

      await BillingWebhookService.handleSubscriptionUpdated(
        _mkStripeSubscription({
          items: {
            data: [{ price: { id: 'price_growth', metadata: { planId: 'growth' } }, current_period_start: 1700000000 }],
          },
        }),
        _mkEvent({
          data: {
            previous_attributes: {
              items: { data: [{ price: { id: 'price_free', metadata: { planId: 'free' } } }] },
            },
          },
        }),
      );

      const subscriptionChangedCalls = mockAnalyticsCapture.mock.calls.filter(
        ([arg]) => arg.event === 'subscription_changed',
      );
      expect(subscriptionChangedCalls).toHaveLength(0);
    });
  });
});
