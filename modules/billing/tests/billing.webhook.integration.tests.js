/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Integration tests for billing webhook service
 */
describe('Billing webhook integration tests:', () => {
  let WebhookService;
  let mockSubscriptionRepository;
  let mockOrganizationRepository;
  let mockResetService;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      findByStripeCustomerId: jest.fn(),
      findByStripeSubscriptionId: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateIfEventNewer: jest.fn().mockResolvedValue({ _id: subId }),
    };

    mockOrganizationRepository = {
      setPlan: jest.fn().mockResolvedValue({}),
    };

    mockResetService = {
      resetWeek: jest.fn().mockResolvedValue({}),
      forceRotateForPlanChange: jest.fn().mockResolvedValue({}),
    };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: mockOrganizationRepository,
    }));

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: () => ({}),
      },
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: {
          plans: ['free', 'starter', 'pro', 'enterprise'],
        },
      },
    }));

    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({
      default: mockResetService,
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: { creditPack: jest.fn(), refundPartial: jest.fn() },
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn() },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    // Mock Stripe so handleCheckoutCompleted can call stripe.subscriptions.retrieve.
    // Default: return 'active' so normal flow proceeds; override per-test as needed.
    jest.unstable_mockModule('../lib/stripe.js', () => ({
      default: jest.fn(() => ({
        subscriptions: {
          retrieve: jest.fn().mockResolvedValue({ status: 'active' }),
        },
      })),
    }));

    const mod = await import('../services/billing.webhook.service.js');
    WebhookService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleCheckoutCompleted', () => {
    const checkoutEvent = { id: 'evt_int_co_1', created: 1700000030, data: {} };

    test('should update existing subscription with valid metadata plan via updateIfEventNewer', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });

      await WebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'pro' },
        },
        checkoutEvent,
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000030,
        'evt_int_co_1',
        expect.objectContaining({ plan: 'pro', status: 'active' }),
        'subscription',
      );
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
    });

    test('should create subscription when none exists with seeded markers', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockSubscriptionRepository.create.mockResolvedValue({});

      await WebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'starter' },
        },
        checkoutEvent,
      );

      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organization: orgId,
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_456',
          plan: 'starter',
          status: 'active',
          lastSubscriptionEventCreatedAt: 1700000030,
          lastSubscriptionEventId: 'evt_int_co_1',
        }),
      );
    });

    test('should fall back to free when metadata plan is invalid (e.g. Stripe product ID)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });

      await WebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'prod_ABC123xyz' },
        },
        checkoutEvent,
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000030,
        'evt_int_co_1',
        expect.objectContaining({ plan: 'free' }),
        'subscription',
      );
    });

    test('should fall back to free when metadata plan is missing', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });

      await WebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId },
        },
        checkoutEvent,
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000030,
        'evt_int_co_1',
        expect.objectContaining({ plan: 'free' }),
        'subscription',
      );
    });

    test('should handle missing organizationId by resolving from stripeCustomerId', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(existing);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });

      await WebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { plan: 'pro' },
        },
        checkoutEvent,
      );

      expect(mockSubscriptionRepository.findByStripeCustomerId).toHaveBeenCalledWith('cus_123');
      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000030,
        'evt_int_co_1',
        expect.objectContaining({ plan: 'pro', status: 'active' }),
        'subscription',
      );
    });

    test('should return early when organizationId cannot be resolved', async () => {
      mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(null);

      await WebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: {},
        },
        checkoutEvent,
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
      expect(mockSubscriptionRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('handleSubscriptionUpdated', () => {
    const makeEvent = (overrides = {}) => ({
      id: 'evt_updated',
      created: 1700000100,
      data: {},
      ...overrides,
    });

    test('should update plan and status via updateIfEventNewer (period details fetched on-demand)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await WebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
          cancel_at_period_end: true,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        makeEvent(),
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000100,
        'evt_updated',
        expect.objectContaining({ plan: 'pro', status: 'active' }),
        'subscription',
      );
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      await WebhookService.handleSubscriptionUpdated(
        { id: 'sub_unknown', items: { data: [] } },
        makeEvent(),
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
    });

    test('should skip org sync when event is stale', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue(null);

      await WebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: 1700000000,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        makeEvent({ created: 500 }),
      );

      expect(mockOrganizationRepository.setPlan).not.toHaveBeenCalled();
    });

    test('should fall back to free when plan metadata is invalid', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await WebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: 1700000000,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'prod_INVALID' } } }] },
        },
        makeEvent(),
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        expect.any(Number),
        expect.any(String),
        expect.objectContaining({ plan: 'free' }),
        'subscription',
      );
    });
  });

  describe('handleSubscriptionDeleted', () => {
    const makeEvent = (overrides = {}) => ({ id: 'evt_deleted', created: 1700000200, ...overrides });

    test('should reset plan to free and status to canceled via updateIfEventNewer', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await WebhookService.handleSubscriptionDeleted({ id: 'sub_456' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000200,
        'evt_deleted',
        { plan: 'free', status: 'canceled' },
        'subscription',
      );
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'free');
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      await WebhookService.handleSubscriptionDeleted({ id: 'sub_unknown' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
    });

    test('should skip org sync when event is stale', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue(null);

      await WebhookService.handleSubscriptionDeleted({ id: 'sub_456' }, makeEvent({ created: 100 }));

      expect(mockOrganizationRepository.setPlan).not.toHaveBeenCalled();
    });

    test('V5 P1 #3: should force rotate meter to free quota on cancellation', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await WebhookService.handleSubscriptionDeleted({ id: 'sub_456' }, makeEvent());

      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledWith(orgId, { preserveUsage: false });
    });

    test('V5 P1 #3: should not throw when forceRotateForPlanChange fails on cancel (non-fatal)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockResetService.forceRotateForPlanChange.mockRejectedValue(new Error('db error'));

      await expect(
        WebhookService.handleSubscriptionDeleted({ id: 'sub_456' }, makeEvent()),
      ).resolves.not.toThrow();

      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'free');
    });
  });

  describe('handleInvoicePaymentFailed', () => {
    const makeEvent = (overrides = {}) => ({ id: 'evt_failed', created: 1700000300, ...overrides });

    test('should set status to past_due via updateIfEventNewer', async () => {
      const existing = { _id: subId, organization: orgId, pastDueSince: null };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await WebhookService.handleInvoicePaymentFailed({ subscription: 'sub_456' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000300,
        'evt_failed',
        expect.objectContaining({ status: 'past_due' }),
        'invoice',
      );
    });

    test('should return early when no subscription ID in invoice', async () => {
      await WebhookService.handleInvoicePaymentFailed({ subscription: null }, makeEvent());

      expect(mockSubscriptionRepository.findByStripeSubscriptionId).not.toHaveBeenCalled();
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      await WebhookService.handleInvoicePaymentFailed({ subscription: 'sub_unknown' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
    });

    test('should skip when event is stale', async () => {
      const existing = { _id: subId, organization: orgId, pastDueSince: null };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue(null);

      await WebhookService.handleInvoicePaymentFailed({ subscription: 'sub_456' }, makeEvent({ created: 50 }));

      expect(mockOrganizationRepository.setPlan).not.toHaveBeenCalled();
    });
  });

  describe('handleSubscriptionCreated', () => {
    const makeEvent = (overrides = {}) => ({ id: 'evt_created', created: 1700000050, data: {}, ...overrides });

    test('should update existing subscription doc via updateIfEventNewer when found by stripeSubscriptionId', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await WebhookService.handleSubscriptionCreated(
        {
          id: 'sub_456',
          customer: 'cus_123',
          status: 'trialing',
          items: { data: [{ current_period_start: 1700000000, price: { metadata: { planId: 'starter' } } }] },
        },
        makeEvent(),
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000050,
        'evt_created',
        expect.objectContaining({ plan: 'starter', status: 'trialing' }),
        'subscription',
      );
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'starter');
    });

    test('should skip org sync when event is stale', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue(null);

      await WebhookService.handleSubscriptionCreated(
        { id: 'sub_456', customer: 'cus_123', status: 'active', items: { data: [] } },
        makeEvent({ created: 10 }),
      );

      expect(mockOrganizationRepository.setPlan).not.toHaveBeenCalled();
    });

    test('should create DB row via stripeCustomerId fallback for Dashboard-created subscriptions', async () => {
      const orgSub = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
      mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(orgSub);
      mockSubscriptionRepository.create.mockResolvedValue({});

      await WebhookService.handleSubscriptionCreated(
        {
          id: 'sub_dashboard_001',
          customer: 'cus_123',
          status: 'active',
          items: { data: [{ current_period_start: 1700000000, price: { metadata: { planId: 'pro' } } }] },
        },
        makeEvent({ id: 'evt_dash_1', created: 1700000060 }),
      );

      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organization: orgId,
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_dashboard_001',
          plan: 'pro',
          status: 'active',
          lastSubscriptionEventCreatedAt: 1700000060,
          lastSubscriptionEventId: 'evt_dash_1',
        }),
      );
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
    });

    test('should log and skip when org cannot be resolved (no stripeCustomerId match)', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
      mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(null);

      await WebhookService.handleSubscriptionCreated(
        { id: 'sub_external', customer: 'cus_unknown', status: 'active', items: { data: [] } },
        makeEvent(),
      );

      expect(mockSubscriptionRepository.create).not.toHaveBeenCalled();
      expect(mockOrganizationRepository.setPlan).not.toHaveBeenCalled();
    });

    test('should skip customer lookup when no customer field on subscription', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      await WebhookService.handleSubscriptionCreated(
        { id: 'sub_nocust', status: 'active', items: { data: [] } },
        makeEvent(),
      );

      expect(mockSubscriptionRepository.findByStripeCustomerId).not.toHaveBeenCalled();
      expect(mockSubscriptionRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('handleChargeDisputeFundsReinstated', () => {
    const makeEvent = (overrides = {}) => ({ id: 'evt_reinstated', data: {}, ...overrides });

    test('should emit billing.dispute.reinstated event on valid dispute', async () => {
      const { default: billingEvents } = await import('../lib/events.js');

      await WebhookService.handleChargeDisputeFundsReinstated(
        { id: 'dp_123', charge: 'ch_456', amount: 5000 },
        makeEvent(),
      );

      expect(billingEvents.emit).toHaveBeenCalledWith('billing.dispute.reinstated', {
        disputeId: 'dp_123',
        chargeId: 'ch_456',
        amount: 5000,
        eventId: 'evt_reinstated',
      });
    });

    test('should skip emit when disputeId is missing', async () => {
      const { default: billingEvents } = await import('../lib/events.js');

      await WebhookService.handleChargeDisputeFundsReinstated(
        { charge: 'ch_456', amount: 5000 },
        makeEvent(),
      );

      expect(billingEvents.emit).not.toHaveBeenCalled();
    });

    test('should skip emit when chargeId is missing', async () => {
      const { default: billingEvents } = await import('../lib/events.js');

      await WebhookService.handleChargeDisputeFundsReinstated(
        { id: 'dp_123', amount: 5000 },
        makeEvent(),
      );

      expect(billingEvents.emit).not.toHaveBeenCalled();
    });
  });

  describe('webhook ordering guard — stale event is skipped', () => {
    test('subscription.updated: event t=10 then t=5 keeps state from t=10', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      // First call (t=10) succeeds
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValueOnce({ _id: subId, lastSubscriptionEventCreatedAt: 10 });
      await WebhookService.handleSubscriptionUpdated(
        { id: 'sub_456', status: 'active', current_period_end: 9999999999, cancel_at_period_end: false, items: { data: [] } },
        { id: 'evt_1', created: 10, data: {} },
      );
      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(subId, 10, 'evt_1', expect.any(Object), expect.any(String));

      // Second call (t=5, older) — repository returns null (guard rejected)
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValueOnce(null);
      await WebhookService.handleSubscriptionUpdated(
        { id: 'sub_456', status: 'canceled', current_period_end: 9999999999, cancel_at_period_end: false, items: { data: [] } },
        { id: 'evt_2', created: 5, data: {} },
      );

      // org plan was synced only once (for the first event)
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledTimes(1);
    });

    test('same-second events: lex-later event ID wins (V5 P1 #2 tiebreaker)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      // First event at t=1000 succeeds
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValueOnce({ _id: subId, lastSubscriptionEventCreatedAt: 1000, lastSubscriptionEventId: 'evt_aaaa' });
      await WebhookService.handleSubscriptionUpdated(
        { id: 'sub_456', status: 'active', current_period_end: 9999999999, cancel_at_period_end: false, items: { data: [] } },
        { id: 'evt_aaaa', created: 1000, data: {} },
      );

      // Second event at same t=1000 with lex-earlier ID — repository returns null (tiebreaker rejected)
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValueOnce(null);
      await WebhookService.handleSubscriptionUpdated(
        { id: 'sub_456', status: 'past_due', current_period_end: 9999999999, cancel_at_period_end: false, items: { data: [] } },
        { id: 'evt_9999', created: 1000, data: {} },
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenNthCalledWith(1, subId, 1000, 'evt_aaaa', expect.any(Object), expect.any(String));
      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenNthCalledWith(2, subId, 1000, 'evt_9999', expect.any(Object), expect.any(String));
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledTimes(1);
    });
  });
});
