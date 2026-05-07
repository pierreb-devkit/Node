/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for BillingAdminService.
 * Covers all 7 admin operations: getCustomerStatus, syncOrgFromStripe, replayWebhookEvent,
 * listDeadLetters, purgeDeadLetter, cancelSubscription, creditDisputeReinstated.
 */
describe('BillingAdminService unit tests:', () => {
  let BillingAdminService;
  let mockSubscriptionRepository;
  let mockProcessedStripeEventRepository;
  let mockOrganizationRepository;
  let mockExtraBalanceRepository;
  let mockWebhookService;
  let mockStripeInstance;
  let mockGetStripe;
  let mockLogger;
  let mockConfig;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439033';
  const stripeSubId = 'sub_test_001';
  const stripeCusId = 'cus_test_001';

  /**
   * @returns {Object} stub subscription doc
   */
  const makeDbSub = (overrides = {}) => ({
    _id: subId,
    organization: orgId,
    plan: 'pro',
    status: 'active',
    stripeCustomerId: stripeCusId,
    stripeSubscriptionId: stripeSubId,
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

    mockConfig = {
      billing: {
        meterMode: true,
        plans: ['free', 'starter', 'pro', 'enterprise'],
      },
    };

    mockSubscriptionRepository = {
      findByOrganization: jest.fn().mockResolvedValue(makeDbSub()),
      update: jest.fn().mockResolvedValue(makeDbSub({ plan: 'free', status: 'canceled' })),
    };

    mockProcessedStripeEventRepository = {
      listDeadLetters: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      purgeDeadLetterByEventId: jest.fn().mockResolvedValue({ purged: true }),
      deleteByEventId: jest.fn().mockResolvedValue({ deleted: true }),
    };

    mockOrganizationRepository = {
      get: jest.fn().mockResolvedValue({ _id: orgId, plan: 'pro' }),
      setPlan: jest.fn().mockResolvedValue({}),
    };

    mockExtraBalanceRepository = {
      creditCompensation: jest.fn().mockResolvedValue({
        doc: {
          ledger: [{ refId: 'dispute-credit-test-uuid-12345', kind: 'adjustment', amount: 2000 }],
          cachedBalance: 2000,
        },
        applied: true,
      }),
    };

    mockWebhookService = {
      withIdempotency: jest.fn().mockResolvedValue({ skipped: false }),
      handleCheckoutSessionCompleted: jest.fn(),
      handleSubscriptionCreated: jest.fn(),
      handleSubscriptionUpdated: jest.fn(),
      handleSubscriptionDeleted: jest.fn(),
      handleInvoicePaymentFailed: jest.fn(),
      handleInvoicePaymentSucceeded: jest.fn(),
      handleChargeRefunded: jest.fn(),
      handleCustomerDeleted: jest.fn(),
      handleChargeDisputeCreated: jest.fn(),
      handleChargeDisputeFundsWithdrawn: jest.fn(),
      handleChargeDisputeFundsReinstated: jest.fn(),
    };

    mockStripeInstance = {
      customers: {
        retrieve: jest.fn().mockResolvedValue({
          id: stripeCusId,
          email: 'test@example.com',
          deleted: false,
          subscriptions: {
            data: [{
              id: stripeSubId,
              status: 'active',
              current_period_end: 1700000000,
              cancel_at_period_end: false,
              items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
            }],
          },
        }),
      },
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({
          id: stripeSubId,
          status: 'active',
          current_period_start: 1699000000,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        }),
        cancel: jest.fn().mockResolvedValue({ id: stripeSubId, status: 'canceled' }),
      },
      events: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'evt_test_001',
          type: 'customer.subscription.updated',
          data: { object: { id: stripeSubId } },
        }),
      },
    };
    mockGetStripe = jest.fn().mockReturnValue(mockStripeInstance);

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: mockGetStripe }));
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));
    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: mockProcessedStripeEventRepository,
    }));
    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: mockOrganizationRepository,
    }));
    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
      default: mockExtraBalanceRepository,
    }));
    jest.unstable_mockModule('../services/billing.webhook.service.js', () => ({
      default: mockWebhookService,
    }));
    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn() },
    }));

    const mod = await import('../services/billing.admin.service.js');
    BillingAdminService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getCustomerStatus
  // ─────────────────────────────────────────────────────────────────────────────
  describe('getCustomerStatus:', () => {
    test('returns db + stripe data side-by-side for valid orgId', async () => {
      const result = await BillingAdminService.getCustomerStatus(orgId);

      expect(result).toHaveProperty('db');
      expect(result).toHaveProperty('stripe');
      expect(result.db.plan).toBe('pro');
      expect(mockStripeInstance.customers.retrieve).toHaveBeenCalledWith(stripeCusId, {
        expand: ['subscriptions'],
      });
    });

    test('returns stripe: null when DB subscription has no stripeCustomerId', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(makeDbSub({ stripeCustomerId: null }));

      const result = await BillingAdminService.getCustomerStatus(orgId);

      expect(result.stripe).toBeNull();
      expect(mockStripeInstance.customers.retrieve).not.toHaveBeenCalled();
    });

    test('throws 422 for invalid orgId format', async () => {
      await expect(BillingAdminService.getCustomerStatus('not-an-id')).rejects.toMatchObject({ status: 422 });
    });

    test('returns stripe.error when Stripe fetch fails (non-fatal — DB still returned)', async () => {
      mockStripeInstance.customers.retrieve.mockRejectedValue(new Error('Stripe down'));

      const result = await BillingAdminService.getCustomerStatus(orgId);

      expect(result.db).toBeDefined();
      expect(result.stripe).toMatchObject({ error: 'Stripe down' });
    });

    test('returns db: null when no subscription exists for org', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);

      const result = await BillingAdminService.getCustomerStatus(orgId);

      expect(result.db).toBeNull();
      expect(result.stripe).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // syncOrgFromStripe
  // ─────────────────────────────────────────────────────────────────────────────
  describe('syncOrgFromStripe:', () => {
    test('syncs status + plan from Stripe and updates org plan', async () => {
      const result = await BillingAdminService.syncOrgFromStripe(orgId);

      expect(mockStripeInstance.subscriptions.retrieve).toHaveBeenCalledWith(stripeSubId);
      expect(mockSubscriptionRepository.update).toHaveBeenCalled();
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
      expect(result).toHaveProperty('previous');
      expect(result).toHaveProperty('updated');
    });

    test('throws 404 when no subscription exists', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);

      await expect(BillingAdminService.syncOrgFromStripe(orgId)).rejects.toMatchObject({ status: 404 });
    });

    test('throws 422 when subscription has no stripeSubscriptionId', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(makeDbSub({ stripeSubscriptionId: null }));

      await expect(BillingAdminService.syncOrgFromStripe(orgId)).rejects.toMatchObject({ status: 422 });
    });

    test('throws 502 when Stripe is not configured', async () => {
      mockGetStripe.mockReturnValue(null);

      await expect(BillingAdminService.syncOrgFromStripe(orgId)).rejects.toMatchObject({ status: 502 });
    });

    test('throws 422 for invalid orgId format', async () => {
      await expect(BillingAdminService.syncOrgFromStripe('bad-id')).rejects.toMatchObject({ status: 422 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // replayWebhookEvent
  // ─────────────────────────────────────────────────────────────────────────────
  describe('replayWebhookEvent:', () => {
    test('fetches event from Stripe, clears record, dispatches via withIdempotency', async () => {
      const result = await BillingAdminService.replayWebhookEvent('evt_test_001');

      expect(mockStripeInstance.events.retrieve).toHaveBeenCalledWith('evt_test_001');
      expect(mockProcessedStripeEventRepository.deleteByEventId).toHaveBeenCalledWith('evt_test_001');
      expect(mockWebhookService.withIdempotency).toHaveBeenCalled();
      expect(result).toMatchObject({ eventId: 'evt_test_001', eventType: 'customer.subscription.updated' });
    });

    test('throws 422 for empty eventId', async () => {
      await expect(BillingAdminService.replayWebhookEvent('')).rejects.toMatchObject({ status: 422 });
    });

    test('throws 502 when Stripe fetch fails', async () => {
      mockStripeInstance.events.retrieve.mockRejectedValue(new Error('network error'));

      await expect(BillingAdminService.replayWebhookEvent('evt_missing')).rejects.toMatchObject({ status: 502 });
    });

    test('throws 502 when Stripe is not configured', async () => {
      mockGetStripe.mockReturnValue(null);

      await expect(BillingAdminService.replayWebhookEvent('evt_test_001')).rejects.toMatchObject({ status: 502 });
    });

    test('propagates deleteByEventId infrastructure errors (not swallowed)', async () => {
      // deleteByEventId returns { deleted: false } for missing docs — never throws.
      // If it does throw (DB connection loss, etc.) the error must propagate, not be swallowed.
      mockProcessedStripeEventRepository.deleteByEventId.mockRejectedValue(new Error('DB connection lost'));

      await expect(BillingAdminService.replayWebhookEvent('evt_test_001')).rejects.toThrow('DB connection lost');
    });

    test('skips unknown event types gracefully (returns skipped sentinel)', async () => {
      mockStripeInstance.events.retrieve.mockResolvedValue({
        id: 'evt_unknown',
        type: 'some.unknown.event',
        data: { object: {} },
      });

      const result = await BillingAdminService.replayWebhookEvent('evt_unknown');
      expect(result.result).toMatchObject({ skipped: true, reason: 'unhandled_event_type' });
    });

    // Each supported event type should route to its withIdempotency handler
    const SUPPORTED_TYPES = [
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.deleted',
      'invoice.payment_failed',
      'invoice.payment_succeeded',
      'charge.refunded',
      'customer.deleted',
      'charge.dispute.created',
      'charge.dispute.funds_withdrawn',
      'charge.dispute.funds_reinstated',
    ];

    test.each(SUPPORTED_TYPES)('dispatches %s via withIdempotency', async (eventType) => {
      mockStripeInstance.events.retrieve.mockResolvedValue({
        id: `evt_${eventType.replace(/\./g, '_')}`,
        type: eventType,
        data: { object: { id: 'sub_test_001' } },
      });

      const result = await BillingAdminService.replayWebhookEvent(`evt_${eventType.replace(/\./g, '_')}`);

      expect(mockWebhookService.withIdempotency).toHaveBeenCalled();
      expect(result).toMatchObject({ eventType });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // listDeadLetters
  // ─────────────────────────────────────────────────────────────────────────────
  describe('listDeadLetters:', () => {
    test('delegates to repository and returns paginated result', async () => {
      mockProcessedStripeEventRepository.listDeadLetters.mockResolvedValue({
        items: [{ eventId: 'evt_dead_001', deadLetter: true }],
        total: 1,
        page: 1,
        limit: 20,
      });

      const result = await BillingAdminService.listDeadLetters({ page: 1, limit: 20 });

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(mockProcessedStripeEventRepository.listDeadLetters).toHaveBeenCalledWith({ page: 1, limit: 20 });
    });

    test('defaults page and limit when not provided', async () => {
      await BillingAdminService.listDeadLetters();
      expect(mockProcessedStripeEventRepository.listDeadLetters).toHaveBeenCalledWith({});
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // purgeDeadLetter
  // ─────────────────────────────────────────────────────────────────────────────
  describe('purgeDeadLetter:', () => {
    test('purges event by eventId and logs', async () => {
      const result = await BillingAdminService.purgeDeadLetter('evt_dead_001');

      expect(mockProcessedStripeEventRepository.purgeDeadLetterByEventId).toHaveBeenCalledWith('evt_dead_001');
      expect(result.purged).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('[billing.admin] purgeDeadLetter — purged', { eventId: 'evt_dead_001' });
    });

    test('throws 404 when event not found (purged: false)', async () => {
      mockProcessedStripeEventRepository.purgeDeadLetterByEventId.mockResolvedValue({ purged: false });

      await expect(BillingAdminService.purgeDeadLetter('evt_gone')).rejects.toMatchObject({ status: 404 });
    });

    test('throws 422 for empty eventId', async () => {
      await expect(BillingAdminService.purgeDeadLetter('')).rejects.toMatchObject({ status: 422 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // cancelSubscription
  // ─────────────────────────────────────────────────────────────────────────────
  describe('cancelSubscription:', () => {
    beforeEach(() => {
      // Default: cancel returns canceled, retrieve confirms canceled
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue({
        id: stripeSubId,
        status: 'canceled',
        items: { data: [{ price: { metadata: { planId: 'free' } } }] },
      });
    });

    test('cancels on Stripe, verifies status, writes DB with canceled/free', async () => {
      const result = await BillingAdminService.cancelSubscription(orgId);

      expect(mockStripeInstance.subscriptions.cancel).toHaveBeenCalledWith(stripeSubId);
      expect(mockStripeInstance.subscriptions.retrieve).toHaveBeenCalledWith(stripeSubId);
      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'free', status: 'canceled' }),
      );
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'free');
      expect(result.stripeStatus).toBe('canceled');
      expect(result.previous.plan).toBe('pro');
    });

    test('throws 404 when subscription not found in DB', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);

      await expect(BillingAdminService.cancelSubscription(orgId)).rejects.toMatchObject({ status: 404 });
    });

    test('throws 422 when subscription has no stripeSubscriptionId', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(makeDbSub({ stripeSubscriptionId: null }));

      await expect(BillingAdminService.cancelSubscription(orgId)).rejects.toMatchObject({ status: 422 });
    });

    test('throws 502 when Stripe is not configured', async () => {
      mockGetStripe.mockReturnValue(null);

      await expect(BillingAdminService.cancelSubscription(orgId)).rejects.toMatchObject({ status: 502 });
    });

    test('throws 422 for invalid orgId format', async () => {
      await expect(BillingAdminService.cancelSubscription('bad-id')).rejects.toMatchObject({ status: 422 });
    });

    test('Decision #5: throws 502 when post-cancel retrieve returns unexpected status', async () => {
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue({
        id: stripeSubId,
        status: 'active', // unexpected — still active after cancel
        items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
      });

      await expect(BillingAdminService.cancelSubscription(orgId)).rejects.toMatchObject({ status: 502 });
    });

    test('Decision #5: treats retrieve failure as canceled (assumes cancel succeeded) + logs error', async () => {
      mockStripeInstance.subscriptions.retrieve.mockRejectedValue(new Error('Stripe unavailable'));

      // Should not throw — assumes canceled, writes DB
      const result = await BillingAdminService.cancelSubscription(orgId);

      expect(result.stripeStatus).toBe('canceled');
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing.admin] cancelSubscription — post-cancel retrieve failed, assuming canceled',
        expect.any(Object),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // creditDisputeReinstated (Item 1 — Batch 2)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('creditDisputeReinstated:', () => {
    const chargeId = 'ch_test_001';
    const amountCents = 2000;
    const reason = 'dispute won — funds reinstated';
    const refundRequestId = 'test-uuid-12345';
    const adminUserId = '617f1f77bcf86cd799439099';

    test('applies credit and returns applied:true + ledgerEntry', async () => {
      const result = await BillingAdminService.creditDisputeReinstated(
        chargeId, amountCents, reason, refundRequestId, orgId, adminUserId,
      );

      expect(result.applied).toBe(true);
      expect(result.ledgerEntry).toBeDefined();
      expect(mockExtraBalanceRepository.creditCompensation).toHaveBeenCalledWith(
        orgId,
        amountCents,
        `dispute-credit-${refundRequestId}`,
        reason,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[billing.admin] creditDisputeReinstated — applied',
        expect.objectContaining({ orgId, chargeId, amountCents, applied: true }),
      );
    });

    test('returns applied:false when creditCompensation reports duplicate_refId (idempotency)', async () => {
      mockExtraBalanceRepository.creditCompensation.mockResolvedValue({
        doc: null,
        applied: false,
        reason: 'duplicate_refId',
      });

      const result = await BillingAdminService.creditDisputeReinstated(
        chargeId, amountCents, reason, refundRequestId, orgId, adminUserId,
      );

      expect(result.applied).toBe(false);
      expect(result.ledgerEntry).toBeNull();
    });

    test('throws 422 for invalid orgId (regex)', async () => {
      await expect(
        BillingAdminService.creditDisputeReinstated(chargeId, amountCents, reason, refundRequestId, 'bad-id', adminUserId),
      ).rejects.toMatchObject({ status: 422 });
    });

    test('throws 422 when org does not exist in DB', async () => {
      mockOrganizationRepository.get.mockResolvedValueOnce(null);
      await expect(
        BillingAdminService.creditDisputeReinstated(chargeId, amountCents, reason, refundRequestId, orgId, adminUserId),
      ).rejects.toMatchObject({ status: 422 });
      expect(mockExtraBalanceRepository.creditCompensation).not.toHaveBeenCalled();
    });

    test('throws 422 for invalid chargeId (not starting with ch_)', async () => {
      await expect(
        BillingAdminService.creditDisputeReinstated('pi_not_a_charge', amountCents, reason, refundRequestId, orgId, adminUserId),
      ).rejects.toMatchObject({ status: 422 });
    });

    test('throws 422 for zero or negative amountCents', async () => {
      await expect(
        BillingAdminService.creditDisputeReinstated(chargeId, 0, reason, refundRequestId, orgId, adminUserId),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        BillingAdminService.creditDisputeReinstated(chargeId, -100, reason, refundRequestId, orgId, adminUserId),
      ).rejects.toMatchObject({ status: 422 });
    });

    test('throws 422 when refundRequestId is too short', async () => {
      await expect(
        BillingAdminService.creditDisputeReinstated(chargeId, amountCents, reason, 'abc', orgId, adminUserId),
      ).rejects.toMatchObject({ status: 422 });
    });

    test('throws 422 when reason is too short', async () => {
      await expect(
        BillingAdminService.creditDisputeReinstated(chargeId, amountCents, 'ab', refundRequestId, orgId, adminUserId),
      ).rejects.toMatchObject({ status: 422 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // dispatchWebhookEvent — covers the switch in admin.service.js (replay path)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('dispatchWebhookEvent (replay):', () => {
    const baseEvent = (type) => ({ id: `evt_${type.replace(/\./g, '_')}`, type, data: { object: { id: 'sub_x' } } });

    test.each([
      ['checkout.session.completed', 'handleCheckoutSessionCompleted'],
      ['customer.subscription.created', 'handleSubscriptionCreated'],
      ['customer.subscription.updated', 'handleSubscriptionUpdated'],
      ['customer.subscription.deleted', 'handleSubscriptionDeleted'],
      ['invoice.payment_failed', 'handleInvoicePaymentFailed'],
      ['invoice.payment_succeeded', 'handleInvoicePaymentSucceeded'],
      ['charge.refunded', 'handleChargeRefunded'],
      ['customer.deleted', 'handleCustomerDeleted'],
      ['charge.dispute.created', 'handleChargeDisputeCreated'],
      ['charge.dispute.funds_withdrawn', 'handleChargeDisputeFundsWithdrawn'],
      ['charge.dispute.funds_reinstated', 'handleChargeDisputeFundsReinstated'],
    ])('routes %s through withIdempotency to %s', async (eventType, handlerName) => {
      const event = baseEvent(eventType);
      mockStripeInstance.events.retrieve.mockResolvedValueOnce(event);
      mockWebhookService.withIdempotency.mockImplementationOnce(async (e, fn) => fn(e));
      mockWebhookService[handlerName].mockResolvedValueOnce({ ok: true });

      await BillingAdminService.replayWebhookEvent(event.id);

      expect(mockWebhookService.withIdempotency).toHaveBeenCalledWith(event, expect.any(Function));
      expect(mockWebhookService[handlerName]).toHaveBeenCalled();
    });

    test('default case logs unhandled event and returns skipped', async () => {
      mockStripeInstance.events.retrieve.mockResolvedValueOnce({
        id: 'evt_unknown',
        type: 'some.unknown.event_type',
        data: { object: {} },
      });

      const out = await BillingAdminService.replayWebhookEvent('evt_unknown');

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('unhandled event type'),
        expect.objectContaining({ type: 'some.unknown.event_type' }),
      );
      expect(out.result).toMatchObject({ skipped: true });
    });
  });
});
