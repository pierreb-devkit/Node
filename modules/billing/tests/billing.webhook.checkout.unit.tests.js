/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for checkout webhook handlers:
 *   - handleCheckoutSessionCompleted routing (subscription vs payment mode)
 *   - handleCheckoutPaymentCompleted (extras pack credit)
 *   - handleCheckoutCompleted (subscription creation/update)
 */
describe('Billing webhook checkout unit tests:', () => {
  let BillingWebhookService;
  let mockSubscriptionRepository;
  let mockOrganizationRepository;
  let mockExtraService;
  let mockResetService;
  let mockStripeInstance;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';
  const stripeSessionId = 'cs_test_session_abc';

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

    mockExtraService = {
      creditPack: jest.fn().mockResolvedValue({ doc: {}, applied: true }),
      refundPartial: jest.fn(),
    };

    mockStripeInstance = {
      paymentIntents: {
        update: jest.fn().mockResolvedValue({}),
      },
      subscriptions: {
        // Default: return 'active' status so handleCheckoutCompleted proceeds normally in tests.
        retrieve: jest.fn().mockResolvedValue({ status: 'active' }),
      },
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
      default: mockExtraService,
    }));

    mockResetService = {
      resetWeek: jest.fn(),
      forceRotateForPlanChange: jest.fn().mockResolvedValue({}),
    };
    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({
      default: mockResetService,
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn() },
    }));

    jest.unstable_mockModule('../lib/stripe.js', () => ({
      default: jest.fn(() => mockStripeInstance),
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: { plans: ['free', 'starter', 'pro', 'enterprise'] },
      },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
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
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('handleCheckoutSessionCompleted routing', () => {
    test('mode=subscription routes to handleCheckoutCompleted (subscription update)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });

      await BillingWebhookService.handleCheckoutSessionCompleted({
        id: 'evt_co_1',
        created: 1700000010,
        data: {
          object: {
            id: stripeSessionId,
            mode: 'subscription',
            customer: 'cus_123',
            subscription: 'sub_456',
            metadata: { organizationId: orgId, plan: 'pro' },
          },
        },
      });

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000010,
        'evt_co_1',
        expect.objectContaining({ plan: 'pro', status: 'active' }),
        'subscription',
      );
      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });

    test('mode=payment + kind=extras + payment_status=paid routes to handleCheckoutPaymentCompleted (creditPack)', async () => {
      await BillingWebhookService.handleCheckoutSessionCompleted({
        data: {
          object: {
            id: stripeSessionId,
            mode: 'payment',
            payment_status: 'paid',
            metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'extras' },
          },
        },
      });

      expect(mockExtraService.creditPack).toHaveBeenCalledWith(orgId, 'pack_500k', stripeSessionId);
      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });

    test('mode=payment without metadata skips creditPack', async () => {
      await BillingWebhookService.handleCheckoutSessionCompleted({
        data: {
          object: {
            id: stripeSessionId,
            mode: 'payment',
            payment_status: 'paid',
            metadata: null,
          },
        },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });

    test('mode=payment + kind≠extras skips creditPack', async () => {
      await BillingWebhookService.handleCheckoutSessionCompleted({
        data: {
          object: {
            id: stripeSessionId,
            mode: 'payment',
            payment_status: 'paid',
            metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'donation' },
          },
        },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });
  });

  describe('handleCheckoutPaymentCompleted', () => {
    test('should call creditPack with orgId, packId, sessionId when payment_status=paid', async () => {
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        payment_status: 'paid',
        metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'extras' },
      });

      expect(mockExtraService.creditPack).toHaveBeenCalledWith(orgId, 'pack_500k', stripeSessionId);
    });

    test('should skip creditPack when payment_status is not paid (e.g. unpaid)', async () => {
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        payment_status: 'unpaid',
        metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'extras' },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });

    test('should skip when kind is not extras', async () => {
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        payment_status: 'paid',
        metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'other' },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });

    test('should skip when organizationId is invalid ObjectId', async () => {
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        payment_status: 'paid',
        metadata: { organizationId: 'not-valid', packId: 'pack_500k', kind: 'extras' },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });

    test('should skip silently when packId is missing', async () => {
      // MEDIUM 3: explicit verification of the silent skip on missing packId
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        payment_status: 'paid',
        metadata: { organizationId: orgId, kind: 'extras' },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });

    test('should skip when organizationId is missing', async () => {
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        payment_status: 'paid',
        metadata: { packId: 'pack_500k', kind: 'extras' },
      });

      expect(mockExtraService.creditPack).not.toHaveBeenCalled();
    });

    test('should call stripe.paymentIntents.update with real sessionId after creditPack succeeds (CRITICAL: refund correlation)', async () => {
      const paymentIntentId = 'pi_test_abc123';

      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        payment_status: 'paid',
        payment_intent: paymentIntentId,
        metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'extras' },
      });

      expect(mockExtraService.creditPack).toHaveBeenCalledWith(orgId, 'pack_500k', stripeSessionId);
      expect(mockStripeInstance.paymentIntents.update).toHaveBeenCalledWith(
        paymentIntentId,
        {
          metadata: {
            organizationId: orgId,
            packId: 'pack_500k',
            kind: 'extras',
            stripeSessionId,  // real cs_* ID (not '__pending__')
          },
        },
      );
    });

    test('should skip paymentIntents.update when payment_intent is absent', async () => {
      await BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        payment_status: 'paid',
        // payment_intent omitted — e.g. in test fixtures without PI
        metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'extras' },
      });

      expect(mockExtraService.creditPack).toHaveBeenCalled();
      expect(mockStripeInstance.paymentIntents.update).not.toHaveBeenCalled();
    });

    test('should not throw when paymentIntents.update fails (non-fatal fallback)', async () => {
      jest.useFakeTimers();
      const paymentIntentId = 'pi_test_failing';
      mockStripeInstance.paymentIntents.update.mockRejectedValue(new Error('Stripe API error'));

      const promise = BillingWebhookService.handleCheckoutPaymentCompleted({
        id: stripeSessionId,
        payment_status: 'paid',
        payment_intent: paymentIntentId,
        metadata: { organizationId: orgId, packId: 'pack_500k', kind: 'extras' },
      });
      // handleCheckoutPaymentCompleted catches the retry exhaustion internally (non-fatal),
      // so the promise resolves; advance the backoff timers while it is pending.
      const assertion = expect(promise).resolves.toBeUndefined();
      await jest.runAllTimersAsync();
      await assertion;

      // creditPack should still have run despite the PI update failure
      expect(mockExtraService.creditPack).toHaveBeenCalledWith(orgId, 'pack_500k', stripeSessionId);
    });
  });

  describe('handleCheckoutCompleted (mode=subscription)', () => {
    const checkoutEvent = { id: 'evt_co_2', created: 1700000020, data: {} };

    test('should update existing subscription via updateIfEventNewer', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });

      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'pro' },
        },
        checkoutEvent,
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000020,
        'evt_co_2',
        expect.objectContaining({ plan: 'pro', status: 'active' }),
        'subscription',
      );
    });

    test('forceRotateForPlanChange called (preserveUsage: true) after activation', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });

      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'pro' },
        },
        checkoutEvent,
      );

      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledWith(orgId, { preserveUsage: true });
    });

    test('forceRotateForPlanChange error is non-fatal (logged, does not throw)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });
      mockResetService.forceRotateForPlanChange.mockRejectedValue(new Error('db unavailable'));

      const { default: mockLogger } = await import('../../../lib/services/logger.js');

      await expect(
        BillingWebhookService.handleCheckoutCompleted(
          {
            customer: 'cus_123',
            subscription: 'sub_456',
            metadata: { organizationId: orgId, plan: 'pro' },
          },
          checkoutEvent,
        ),
      ).resolves.not.toThrow();
      // The subscription write already committed before the rotation call — a rotation
      // failure must not roll it back or propagate.
      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[billing.webhook] forceRotateForPlanChange failed after checkout.session.completed',
        expect.objectContaining({ organizationId: orgId }),
      );
    });

    test('should create subscription with seeded markers when none exists', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockSubscriptionRepository.create.mockResolvedValue({});

      await BillingWebhookService.handleCheckoutCompleted(
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
          plan: 'starter',
          status: 'active',
          lastSubscriptionEventCreatedAt: 1700000020,
          lastSubscriptionEventId: 'evt_co_2',
        }),
      );
    });

    test('should persist real status from Stripe (trialing, not active)', async () => {
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue({ status: 'trialing' });
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });

      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'pro' },
        },
        checkoutEvent,
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000020,
        'evt_co_2',
        expect.objectContaining({ status: 'trialing' }),
        'subscription',
      );
    });

    test('should abort without persisting when stripe.subscriptions.retrieve throws', async () => {
      mockStripeInstance.subscriptions.retrieve.mockRejectedValue(new Error('Stripe API error'));

      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'pro' },
        },
        checkoutEvent,
      );

      // Should not persist anything — aborting to avoid stale 'active' assumption
      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
      expect(mockSubscriptionRepository.create).not.toHaveBeenCalled();
    });

    test('should abort without persisting when stripe returns null status', async () => {
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue({ status: null });

      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'pro' },
        },
        checkoutEvent,
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
      expect(mockSubscriptionRepository.create).not.toHaveBeenCalled();
    });

    test('should return early without querying when stripeSubscriptionId is missing', async () => {
      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          // subscription omitted — e.g. mode=subscription but sub not created yet
          metadata: { organizationId: orgId, plan: 'pro' },
        },
        checkoutEvent,
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
      expect(mockSubscriptionRepository.create).not.toHaveBeenCalled();
    });

    test('should abort without querying when Stripe is not configured (getStripe returns null)', async () => {
      // The billing.webhook.checkout.unit.tests.js mocks stripe.js at module level.
      // To test the getStripe()=null branch, we reload the module with a null-returning mock.
      jest.resetModules();
      jest.unstable_mockModule('../lib/stripe.js', () => ({ default: jest.fn(() => null) }));
      jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
        default: mockSubscriptionRepository,
      }));
      jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
        default: { wasProcessed: jest.fn().mockResolvedValue(false), tryRecord: jest.fn().mockResolvedValue({ recorded: true }) },
      }));
      jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
        default: mockOrganizationRepository,
      }));
      jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
        default: { creditPack: jest.fn(), refundPartial: jest.fn() },
      }));
      jest.unstable_mockModule('../services/billing.reset.service.js', () => ({
        default: { resetWeek: jest.fn() },
      }));
      jest.unstable_mockModule('../lib/events.js', () => ({ default: { emit: jest.fn() } }));
      jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
        default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
      }));
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { billing: { plans: ['free', 'starter', 'pro', 'enterprise'] } },
      }));
      jest.unstable_mockModule('mongoose', () => ({
        default: { Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } }, model: () => ({}) },
      }));

      const mod2 = await import('../services/billing.webhook.service.js');
      const svc2 = mod2.default;

      await svc2.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'pro' },
        },
        checkoutEvent,
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
      expect(mockSubscriptionRepository.create).not.toHaveBeenCalled();
    });

    test('should skip org sync when checkout event is stale (updateIfEventNewer returns null)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue(null);

      await BillingWebhookService.handleCheckoutCompleted(
        {
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: { organizationId: orgId, plan: 'pro' },
        },
        checkoutEvent,
      );

      // Event was stale — org plan should not be synced
      expect(mockOrganizationRepository.setPlan).not.toHaveBeenCalled();
    });
  });
});
