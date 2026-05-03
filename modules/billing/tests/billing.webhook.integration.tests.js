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

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn() },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    WebhookService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleCheckoutCompleted', () => {
    test('should update existing subscription with valid metadata plan', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId, plan: 'pro' },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ _id: subId, plan: 'pro', status: 'active' }),
      );
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
    });

    test('should create subscription when none exists', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockSubscriptionRepository.create.mockResolvedValue({});

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId, plan: 'starter' },
      });

      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organization: orgId,
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_456',
          plan: 'starter',
          status: 'active',
        }),
      );
    });

    test('should fall back to free when metadata plan is invalid (e.g. Stripe product ID)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId, plan: 'prod_ABC123xyz' },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'free' }),
      );
    });

    test('should fall back to free when metadata plan is missing', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { organizationId: orgId },
      });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'free' }),
      );
    });

    test('should handle missing organizationId by resolving from stripeCustomerId', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(existing);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { plan: 'pro' },
      });

      expect(mockSubscriptionRepository.findByStripeCustomerId).toHaveBeenCalledWith('cus_123');
      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'pro', status: 'active' }),
      );
    });

    test('should return early when organizationId cannot be resolved', async () => {
      mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(null);

      await WebhookService.handleCheckoutCompleted({
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: {},
      });

      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
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

    test('should update plan, status, currentPeriodEnd, cancelAtPeriodEnd via updateIfEventNewer', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      const periodEnd = Math.floor(Date.now() / 1000) + 86400;

      await WebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: periodEnd,
          cancel_at_period_end: true,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        makeEvent(),
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000100,
        expect.objectContaining({
          plan: 'pro',
          status: 'active',
          currentPeriodEnd: new Date(periodEnd * 1000),
          cancelAtPeriodEnd: true,
        }),
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
        expect.objectContaining({ plan: 'free' }),
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
        { plan: 'free', status: 'canceled' },
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
        expect.objectContaining({ status: 'past_due' }),
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

  describe('webhook ordering guard — stale event is skipped', () => {
    test('subscription.updated: event t=10 then t=5 keeps state from t=10', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      // First call (t=10) succeeds
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValueOnce({ _id: subId, stripeEventCreatedAt: 10 });
      await WebhookService.handleSubscriptionUpdated(
        { id: 'sub_456', status: 'active', current_period_end: 9999999999, cancel_at_period_end: false, items: { data: [] } },
        { id: 'evt_1', created: 10, data: {} },
      );
      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(subId, 10, expect.any(Object));

      // Second call (t=5, older) — repository returns null (guard rejected)
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValueOnce(null);
      await WebhookService.handleSubscriptionUpdated(
        { id: 'sub_456', status: 'canceled', current_period_end: 9999999999, cancel_at_period_end: false, items: { data: [] } },
        { id: 'evt_2', created: 5, data: {} },
      );

      // org plan was synced only once (for the first event)
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledTimes(1);
    });
  });
});
