/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for billing webhook service
 */
describe('Billing webhook service unit tests:', () => {
  let BillingWebhookService;
  let mockSubscriptionRepository;
  let mockOrganizationRepository;

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
      updateIfEventNewer: jest.fn().mockResolvedValue({ _id: '507f1f77bcf86cd799439022' }),
    };

    mockOrganizationRepository = {
      setPlan: jest.fn().mockResolvedValue({}),
    };

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
      default: { resetWeek: jest.fn(), resetAllDue: jest.fn(), forceRotateForPlanChange: jest.fn().mockResolvedValue({}) },
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn() },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { billing: { plans: ['free', 'starter', 'pro', 'enterprise'] } },
    }));

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn().mockReturnValue({}),
        Types: { ObjectId: { isValid: jest.fn().mockReturnValue(true) } },
      },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleCheckoutCompleted', () => {
    // Synthetic event passed to handleCheckoutCompleted (second arg) for event-ordering markers.
    const makeCheckoutEvent = () => ({ id: 'evt_checkout_1', created: 1700000050, data: {} });

    test('should create new subscription when none exists', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockSubscriptionRepository.create.mockResolvedValue({});

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'pro' },
        },
        makeCheckoutEvent(),
      );

      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organization: orgId,
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_456',
          plan: 'pro',
          // Status fetched from Stripe; falls back to 'active' when getStripe() returns null in tests.
          status: 'active',
          lastSubscriptionEventCreatedAt: 1700000050,
          lastSubscriptionEventId: 'evt_checkout_1',
        }),
      );
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
    });

    test('should update existing subscription on checkout via updateIfEventNewer', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ _id: subId });
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'starter' },
        },
        makeCheckoutEvent(),
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000050,
        'evt_checkout_1',
        expect.objectContaining({
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_456',
          plan: 'starter',
          status: 'active',
        }),
        'subscription',
      );
    });

    test('should default plan to free when metadata plan is missing', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockSubscriptionRepository.create.mockResolvedValue({});

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId },
        },
        makeCheckoutEvent(),
      );

      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'free' }),
      );
    });

    test('should return early when organizationId is missing and no customer fallback', async () => {
      mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(null);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_unknown',
          subscription: 'sub_456',
          metadata: {},
        },
        makeCheckoutEvent(),
      );

      expect(mockSubscriptionRepository.findByStripeCustomerId).toHaveBeenCalledWith('cus_unknown');
      expect(mockSubscriptionRepository.findByOrganization).not.toHaveBeenCalled();
    });

    test('should fallback to stripeCustomerId when organizationId is missing in metadata', async () => {
      mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue({ organization: { _id: orgId } });
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockSubscriptionRepository.create.mockResolvedValue({});

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: {},
        },
        makeCheckoutEvent(),
      );

      expect(mockSubscriptionRepository.findByStripeCustomerId).toHaveBeenCalledWith('cus_123');
      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ organization: orgId }),
      );
    });
  });

  describe('handleSubscriptionUpdated', () => {
    const makeEvent = (overrides = {}) => ({ id: 'evt_1', created: 1700000100, data: {}, ...overrides });

    test('should update subscription when found', async () => {
      const existing = { _id: subId, organization: { _id: orgId } };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: 1700000000,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        makeEvent(),
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000100,
        'evt_1',
        expect.objectContaining({ plan: 'pro', status: 'active' }),
        'subscription',
      );
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleSubscriptionUpdated({ id: 'sub_unknown', items: {} }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
    });

    test('should fall back to plan metadata from item.plan', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: 1700000000,
          cancel_at_period_end: true,
          items: { data: [{ plan: { metadata: { planId: 'starter' } } }] },
        },
        makeEvent(),
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000100,
        'evt_1',
        expect.objectContaining({ plan: 'starter' }),
        'subscription',
      );
    });

    test('should default plan to free when no metadata', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: 1700000000,
          cancel_at_period_end: false,
          items: { data: [{}] },
        },
        makeEvent(),
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000100,
        'evt_1',
        expect.objectContaining({ plan: 'free' }),
        'subscription',
      );
    });
  });

  describe('handleSubscriptionDeleted', () => {
    const makeEvent = (overrides = {}) => ({ id: 'evt_del', created: 1700000200, ...overrides });

    test('should cancel subscription, reset to free, and rotate meter', async () => {
      const existing = { _id: subId, organization: { _id: orgId } };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      const resetService = (await import('../services/billing.reset.service.js')).default;

      await BillingWebhookService.handleSubscriptionDeleted({ id: 'sub_456' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000200,
        'evt_del',
        { plan: 'free', status: 'canceled' },
        'subscription',
      );
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'free');
      expect(resetService.forceRotateForPlanChange).toHaveBeenCalledWith(orgId, { preserveUsage: false });
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleSubscriptionDeleted({ id: 'sub_unknown' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
    });
  });

  describe('handleInvoicePaymentFailed', () => {
    const makeEvent = (overrides = {}) => ({ id: 'evt_fail', created: 1700000300, ...overrides });

    test('should mark subscription as past_due and set pastDueSince on first failure', async () => {
      const existing = { _id: subId, organization: orgId, pastDueSince: null };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: 'sub_456' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000300,
        'evt_fail',
        expect.objectContaining({ status: 'past_due', pastDueSince: expect.any(Date) }),
        'invoice',
      );
    });

    test('should return early when no subscription ID in invoice', async () => {
      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: null }, makeEvent());

      expect(mockSubscriptionRepository.findByStripeSubscriptionId).not.toHaveBeenCalled();
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      const mod = await import('../services/billing.webhook.service.js');
      BillingWebhookService = mod.default;

      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: 'sub_unknown' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
    });
  });
});
