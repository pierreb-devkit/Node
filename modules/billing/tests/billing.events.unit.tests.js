/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for billing plan.changed event
 */
describe('Billing plan.changed event unit tests:', () => {
  let BillingWebhookService;
  let billingEvents;
  let mockSubscriptionRepository;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '507f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      findByStripeSubscriptionId: jest.fn(),
      findByStripeCustomerId: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn().mockReturnValue({
          findByIdAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
        }),
        Types: { ObjectId: { isValid: jest.fn().mockReturnValue(true) } },
      },
    }));

    // Import service and events from the same module context
    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
    const eventsModule = await import('../lib/events.js');
    billingEvents = eventsModule.default;
  });

  afterEach(() => {
    billingEvents.removeAllListeners('plan.changed');
    jest.restoreAllMocks();
  });

  test('should emit plan.changed event when plan changes (downgrade)', async () => {
    const existing = { _id: subId, organization: { _id: orgId } };
    mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
    mockSubscriptionRepository.update.mockResolvedValue({});

    const handler = jest.fn();
    billingEvents.on('plan.changed', handler);

    const subscription = {
      id: 'sub_456',
      status: 'active',
      current_period_end: 1700000000,
      cancel_at_period_end: false,
      items: { data: [{ price: { metadata: { planId: 'starter' } } }] },
    };

    const event = {
      data: {
        object: subscription,
        previous_attributes: {
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
      },
    };

    await BillingWebhookService.handleSubscriptionUpdated(subscription, event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      organizationId: orgId,
      previousPlan: 'pro',
      newPlan: 'starter',
      subscription,
      isDowngrade: true,
    });
  });

  test('should not emit plan.changed event when plan has not changed', async () => {
    const existing = { _id: subId, organization: { _id: orgId } };
    mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
    mockSubscriptionRepository.update.mockResolvedValue({});

    const handler = jest.fn();
    billingEvents.on('plan.changed', handler);

    const subscription = {
      id: 'sub_456',
      status: 'active',
      current_period_end: 1700000000,
      cancel_at_period_end: false,
      items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
    };

    // No previous_attributes means no plan change
    const event = { data: { object: subscription } };

    await BillingWebhookService.handleSubscriptionUpdated(subscription, event);

    expect(handler).not.toHaveBeenCalled();
  });

  test('should detect upgrade (isDowngrade = false) when moving to higher plan', async () => {
    const existing = { _id: subId, organization: orgId };
    mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
    mockSubscriptionRepository.update.mockResolvedValue({});

    const handler = jest.fn();
    billingEvents.on('plan.changed', handler);

    const subscription = {
      id: 'sub_456',
      status: 'active',
      current_period_end: 1700000000,
      cancel_at_period_end: false,
      items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
    };

    const event = {
      data: {
        object: subscription,
        previous_attributes: {
          items: { data: [{ price: { metadata: { planId: 'starter' } } }] },
        },
      },
    };

    await BillingWebhookService.handleSubscriptionUpdated(subscription, event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        previousPlan: 'starter',
        newPlan: 'pro',
        isDowngrade: false,
      }),
    );
  });

  test('should detect downgrade from enterprise to free', async () => {
    const existing = { _id: subId, organization: orgId };
    mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
    mockSubscriptionRepository.update.mockResolvedValue({});

    const handler = jest.fn();
    billingEvents.on('plan.changed', handler);

    const subscription = {
      id: 'sub_456',
      status: 'active',
      current_period_end: 1700000000,
      cancel_at_period_end: false,
      items: { data: [{ price: { metadata: { planId: 'free' } } }] },
    };

    const event = {
      data: {
        object: subscription,
        previous_attributes: {
          items: { data: [{ price: { metadata: { planId: 'enterprise' } } }] },
        },
      },
    };

    await BillingWebhookService.handleSubscriptionUpdated(subscription, event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        previousPlan: 'enterprise',
        newPlan: 'free',
        isDowngrade: true,
      }),
    );
  });

  test('should not emit when previous_attributes has items but same plan', async () => {
    const existing = { _id: subId, organization: orgId };
    mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
    mockSubscriptionRepository.update.mockResolvedValue({});

    const handler = jest.fn();
    billingEvents.on('plan.changed', handler);

    const subscription = {
      id: 'sub_456',
      status: 'active',
      current_period_end: 1700000000,
      cancel_at_period_end: false,
      items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
    };

    const event = {
      data: {
        object: subscription,
        previous_attributes: {
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
      },
    };

    await BillingWebhookService.handleSubscriptionUpdated(subscription, event);

    expect(handler).not.toHaveBeenCalled();
  });
});
