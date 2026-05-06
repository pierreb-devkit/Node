/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for billing service
 */
describe('Billing service unit tests:', () => {
  let BillingService;
  let mockStripeInstance;
  let mockSubscriptionRepository;
  let mockPlansService;

  const orgId = '507f1f77bcf86cd799439011';
  const mockOrganization = { _id: orgId, name: 'Test Org' };
  const validPlans = [
    { planId: 'starter', name: 'Starter', stripePriceMonthly: 'price_starter_m', stripePriceAnnual: 'price_starter_y' },
    { planId: 'pro', name: 'Pro', stripePriceMonthly: 'price_pro_m', stripePriceAnnual: 'price_pro_y' },
  ];

  beforeEach(async () => {
    jest.resetModules();

    mockStripeInstance = {
      customers: {
        create: jest.fn().mockResolvedValue({ id: 'cus_new123' }),
      },
      checkout: {
        sessions: {
          create: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/session_123' }),
        },
      },
      billingPortal: {
        sessions: {
          create: jest.fn().mockResolvedValue({ url: 'https://billing.stripe.com/portal_123' }),
        },
      },
      subscriptions: {
        // Default: no live active/trialing subs — checkout proceeds
        list: jest.fn().mockResolvedValue({ data: [] }),
      },
    };

    jest.unstable_mockModule('stripe', () => ({
      default: jest.fn(() => mockStripeInstance),
    }));

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    mockPlansService = {
      getPlans: jest.fn().mockResolvedValue(validPlans),
    };

    jest.unstable_mockModule('../services/billing.plans.service.js', () => ({
      default: mockPlansService,
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createCheckout', () => {
    test('should throw when stripe is not configured', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: {} },
      }));

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(
        BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel'),
      ).rejects.toThrow('Stripe is not configured');
    });

    test('should throw when stripe config is null', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {},
      }));

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(
        BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel'),
      ).rejects.toThrow('Stripe is not configured');
    });

    test('should throw when redirect URL is invalid', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_url' } },
      }));

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(
        BillingService.createCheckout(mockOrganization, 'price_starter_m', 'not-a-url', 'http://cancel'),
      ).rejects.toThrow('Invalid redirect URL');
    });

    test('should allow any domain in dev/test even when config.domain is set', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_domain' }, domain: 'https://myapp.com' },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        stripeCustomerId: 'cus_existing',
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const url = await BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://evil.com/success', 'http://myapp.com/cancel');

      expect(url).toBe('https://checkout.stripe.com/session_123');
    });

    test('should reject mismatched hostname in production when config.domain is set', async () => {
      const originalEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';

        jest.unstable_mockModule('../../../config/index.js', () => ({
          default: { stripe: { secretKey: 'sk_test_prodcheck' }, domain: 'https://myapp.com' },
        }));

        mockSubscriptionRepository.findByOrganization.mockResolvedValue({
          stripeCustomerId: 'cus_existing',
        });

        const mod = await import('../services/billing.service.js');
        BillingService = mod.default;

        await expect(
          BillingService.createCheckout(mockOrganization, 'price_starter_m', 'https://evil.com/success', 'https://myapp.com/cancel'),
        ).rejects.toThrow('Invalid redirect URL');
      } finally {
        if (originalEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalEnv;
      }
    });

    test('should throw when priceId is not in allowed plans', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_price' } },
      }));

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(
        BillingService.createCheckout(mockOrganization, 'price_tampered', 'http://ok', 'http://cancel'),
      ).rejects.toThrow('Invalid priceId');
    });

    test('should create customer and subscription when none exists', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_123' } },
      }));

      const createdSub = { stripeCustomerId: 'cus_new123' };
      mockSubscriptionRepository.findByOrganization
        .mockResolvedValueOnce(null)   // block guard: no active sub
        .mockResolvedValueOnce(null)   // _ensureStripeCustomer: no existing sub → create customer
        .mockResolvedValueOnce(createdSub); // _ensureStripeCustomer: final check
      mockSubscriptionRepository.create.mockResolvedValue(createdSub);

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const url = await BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel');

      expect(url).toBe('https://checkout.stripe.com/session_123');
      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith(
        { name: 'Test Org', metadata: { organizationId: orgId } },
        { idempotencyKey: `cus_create_${orgId}` },
      );
      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith({
        organization: orgId,
        stripeCustomerId: 'cus_new123',
      });
    });

    test('should update existing subscription without stripeCustomerId', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_456' } },
      }));

      const existingSub = { _id: 'sub_existing', stripeCustomerId: null };
      const updatedSub = { _id: 'sub_existing', stripeCustomerId: 'cus_new123' };
      mockSubscriptionRepository.findByOrganization
        .mockResolvedValueOnce(existingSub)  // block guard: no stripeSubscriptionId → no block
        .mockResolvedValueOnce(existingSub)  // _ensureStripeCustomer: has no stripeCustomerId → create
        .mockResolvedValueOnce(updatedSub);  // _ensureStripeCustomer: final check
      mockSubscriptionRepository.update.mockResolvedValue(updatedSub);

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const url = await BillingService.createCheckout(mockOrganization, 'price_pro_y', 'http://ok', 'http://cancel');

      expect(url).toBe('https://checkout.stripe.com/session_123');
      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith({
        _id: 'sub_existing',
        stripeCustomerId: 'cus_new123',
      });
    });

    test('should use existing customer when subscription has stripeCustomerId — automaticTax off by default', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_789' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        stripeCustomerId: 'cus_existing',
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const url = await BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel');

      expect(url).toBe('https://checkout.stripe.com/session_123');
      expect(mockStripeInstance.customers.create).not.toHaveBeenCalled();
      // No idempotencyKey on checkout sessions — they're ephemeral (24h TTL),
      // a static key locks abandoned-then-retried users into expired sessions.
      expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith({
        customer: 'cus_existing',
        mode: 'subscription',
        line_items: [{ price: 'price_starter_m', quantity: 1 }],
        success_url: 'http://ok',
        cancel_url: 'http://cancel',
        metadata: {
          organizationId: orgId,
          plan: 'starter',
        },
      });
    });

    test('should NOT include automatic_tax when config.stripe.automaticTax is false', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_no_tax', automaticTax: false } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        stripeCustomerId: 'cus_no_tax',
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel');

      const callArgs = mockStripeInstance.checkout.sessions.create.mock.calls[0][0];
      expect(callArgs.automatic_tax).toBeUndefined();
      expect(callArgs.customer_update).toBeUndefined();
    });

    test('should include automatic_tax and customer_update when config.stripe.automaticTax is true', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_with_tax', automaticTax: true } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        stripeCustomerId: 'cus_with_tax',
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel');

      const callArgs = mockStripeInstance.checkout.sessions.create.mock.calls[0][0];
      expect(callArgs.automatic_tax).toEqual({ enabled: true });
      expect(callArgs.customer_update).toEqual({ address: 'auto', name: 'auto' });
    });

    test('should NOT include automatic_tax when config.stripe.automaticTax is truthy but not strict true (e.g. 1)', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_truthy_tax', automaticTax: 1 } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        stripeCustomerId: 'cus_truthy_tax',
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel');

      const callArgs = mockStripeInstance.checkout.sessions.create.mock.calls[0][0];
      expect(callArgs.automatic_tax).toBeUndefined();
      expect(callArgs.customer_update).toBeUndefined();
    });

    test('should throw 409 with portalUrl when active subscription exists', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_block_active' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        stripeCustomerId: 'cus_active',
        stripeSubscriptionId: 'sub_active',
        status: 'active',
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(
        BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel'),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'subscription_already_active',
        portalUrl: 'https://billing.stripe.com/portal_123',
      });

      expect(mockStripeInstance.checkout.sessions.create).not.toHaveBeenCalled();
      expect(mockStripeInstance.billingPortal.sessions.create).toHaveBeenCalledWith({
        customer: 'cus_active',
      });
    });

    test('should throw 409 with portalUrl when past_due subscription exists', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_block_past_due' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        stripeCustomerId: 'cus_past_due',
        stripeSubscriptionId: 'sub_past_due',
        status: 'past_due',
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(
        BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel'),
      ).rejects.toMatchObject({ statusCode: 409, code: 'subscription_already_active' });
    });

    test('should allow checkout when subscription is canceled', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_allow_canceled' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        stripeCustomerId: 'cus_canceled',
        stripeSubscriptionId: 'sub_old',
        status: 'canceled',
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const url = await BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel');

      expect(url).toBe('https://checkout.stripe.com/session_123');
      expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalled();
    });

    test('should allow checkout when no stripeSubscriptionId even if status is active', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_allow_no_sub_id' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        stripeCustomerId: 'cus_no_sub_id',
        stripeSubscriptionId: null,
        status: 'active',
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const url = await BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel');

      expect(url).toBe('https://checkout.stripe.com/session_123');
    });

    // ── Stripe-side live guard (trialing race window) ──────────────────────────────────────────

    test('should throw 409 subscription_already_active when Stripe lists a trialing sub but DB shows none', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_live_trialing' } },
      }));

      // DB shows no active sub locally — only the Stripe live check should catch this
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        organization: orgId,
        stripeCustomerId: 'cus_x',
        stripeSubscriptionId: null,
        plan: 'free',
        status: 'canceled',
      });

      // Stripe live check returns a trialing sub
      mockStripeInstance.subscriptions.list.mockResolvedValue({
        data: [{ id: 'sub_trial_x', status: 'trialing' }],
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(
        BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel'),
      ).rejects.toMatchObject({ code: 'subscription_already_active', statusCode: 409 });

      // Verify the live Stripe check was called with the correct params
      expect(mockStripeInstance.subscriptions.list).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_x', status: 'all', limit: 10 }),
      );
      expect(mockStripeInstance.checkout.sessions.create).not.toHaveBeenCalled();
    });

    test('should throw 409 subscription_already_active when Stripe lists an active sub but DB shows none', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_live_active' } },
      }));

      // DB shows no active sub locally — only the Stripe live check should catch this
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        organization: orgId,
        stripeCustomerId: 'cus_x',
        stripeSubscriptionId: null,
        plan: 'free',
        status: 'canceled',
      });

      // Stripe live check returns an active sub
      mockStripeInstance.subscriptions.list.mockResolvedValue({
        data: [{ id: 'sub_active_x', status: 'active' }],
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(
        BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel'),
      ).rejects.toMatchObject({ code: 'subscription_already_active', statusCode: 409 });

      expect(mockStripeInstance.subscriptions.list).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_x', status: 'all', limit: 10 }),
      );
      expect(mockStripeInstance.checkout.sessions.create).not.toHaveBeenCalled();
    });

    test('should NOT block checkout when Stripe lists an incomplete sub (incomplete is not in block list)', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_live_incomplete' } },
      }));

      // DB shows no active sub locally
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        organization: orgId,
        stripeCustomerId: 'cus_x',
        stripeSubscriptionId: null,
        plan: 'free',
        status: 'canceled',
      });

      // Stripe returns only an incomplete sub — should NOT block (deliberate asymmetry vs DB guard)
      mockStripeInstance.subscriptions.list.mockResolvedValue({
        data: [{ id: 'sub_incomplete_x', status: 'incomplete' }],
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const url = await BillingService.createCheckout(mockOrganization, 'price_starter_m', 'http://ok', 'http://cancel');

      expect(url).toBe('https://checkout.stripe.com/session_123');
      expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalled();
    });
  });

  describe('createPortalSession', () => {
    test('should throw when stripe is not configured', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: {} },
      }));

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(BillingService.createPortalSession(mockOrganization)).rejects.toThrow('Stripe is not configured');
    });

    test('should throw when no customer found', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_portal1' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(BillingService.createPortalSession(mockOrganization)).rejects.toThrow(
        'No Stripe customer found for this organization',
      );
    });

    test('should throw when subscription has no stripeCustomerId', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_portal2' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: null });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(BillingService.createPortalSession(mockOrganization)).rejects.toThrow(
        'No Stripe customer found for this organization',
      );
    });

    test('should return portal session URL without returnUrl', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_portal3' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: 'cus_portal' });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const url = await BillingService.createPortalSession(mockOrganization);

      expect(url).toBe('https://billing.stripe.com/portal_123');
      expect(mockStripeInstance.billingPortal.sessions.create).toHaveBeenCalledWith({
        customer: 'cus_portal',
      });
    });

    test('should include return_url when returnUrl is provided', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_portal4' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: 'cus_portal' });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const url = await BillingService.createPortalSession(mockOrganization, 'http://app/settings');

      expect(url).toBe('https://billing.stripe.com/portal_123');
      expect(mockStripeInstance.billingPortal.sessions.create).toHaveBeenCalledWith({
        customer: 'cus_portal',
        return_url: 'http://app/settings',
      });
    });

    test('should throw when returnUrl is invalid', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_portal5' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: 'cus_portal' });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(BillingService.createPortalSession(mockOrganization, 'not-a-url')).rejects.toThrow('Invalid return URL');
    });
  });

  describe('createExtrasCheckout — automaticTax flag', () => {
    test('should NOT include automatic_tax when config.stripe.automaticTax is false', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          stripe: {
            secretKey: 'sk_test_ext_no_tax',
            automaticTax: false,
            prices: { packs: { pack_500k: 'price_pack500' } },
          },
          billing: {
            packs: [{ packId: 'pack_500k', meterUnits: 500000 }],
          },
        },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        stripeCustomerId: 'cus_ext_no_tax',
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await BillingService.createExtrasCheckout(mockOrganization, 'pack_500k', 'http://ok', 'http://cancel');

      const callArgs = mockStripeInstance.checkout.sessions.create.mock.calls[0][0];
      expect(callArgs.automatic_tax).toBeUndefined();
      expect(callArgs.customer_update).toBeUndefined();
    });

    test('should include automatic_tax and customer_update when config.stripe.automaticTax is true', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          stripe: {
            secretKey: 'sk_test_ext_with_tax',
            automaticTax: true,
            prices: { packs: { pack_500k: 'price_pack500' } },
          },
          billing: {
            packs: [{ packId: 'pack_500k', meterUnits: 500000 }],
          },
        },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        stripeCustomerId: 'cus_ext_with_tax',
      });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await BillingService.createExtrasCheckout(mockOrganization, 'pack_500k', 'http://ok', 'http://cancel');

      const callArgs = mockStripeInstance.checkout.sessions.create.mock.calls[0][0];
      expect(callArgs.automatic_tax).toEqual({ enabled: true });
      expect(callArgs.customer_update).toEqual({ address: 'auto', name: 'auto' });
    });
  });

  describe('getSubscription', () => {
    test('should return subscription merged with Stripe details when stripeSubscriptionId exists', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_sub1' } },
      }));

      const periodEnd = Math.floor(Date.now() / 1000) + 86400;
      mockStripeInstance.subscriptions = {
        retrieve: jest.fn().mockResolvedValue({
          current_period_start: periodEnd - 2592000,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          status: 'active',
          cancel_at: null,
        }),
      };

      const mockSub = { organization: orgId, plan: 'pro', stripeSubscriptionId: 'sub_456', toJSON: () => ({ organization: orgId, plan: 'pro', stripeSubscriptionId: 'sub_456' }) };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(mockSub);

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const result = await BillingService.getSubscription(orgId);

      expect(result).toMatchObject({ plan: 'pro', cancelAtPeriodEnd: false, status: 'active' });
      expect(result.currentPeriodEnd).toBeInstanceOf(Date);
      expect(mockStripeInstance.subscriptions.retrieve).toHaveBeenCalledWith('sub_456');
    });

    test('should return cached sub without Stripe fetch when no stripeSubscriptionId (free plan)', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_sub_free' } },
      }));

      mockStripeInstance.subscriptions = { retrieve: jest.fn() };

      const mockSub = { organization: orgId, plan: 'free', stripeSubscriptionId: null };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(mockSub);

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const result = await BillingService.getSubscription(orgId);

      expect(result).toEqual(mockSub);
      expect(mockStripeInstance.subscriptions.retrieve).not.toHaveBeenCalled();
    });

    test('should return null when no subscription exists', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_sub2' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const result = await BillingService.getSubscription(orgId);

      expect(result).toBeNull();
    });

    test('should return cached sub when Stripe fetch throws (graceful fallback)', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_sub_fallback' } },
      }));

      mockStripeInstance.subscriptions = {
        retrieve: jest.fn().mockRejectedValue(new Error('Stripe unreachable')),
      };

      const mockSub = { organization: orgId, plan: 'pro', stripeSubscriptionId: 'sub_789', toJSON: () => ({ organization: orgId, plan: 'pro' }) };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(mockSub);

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const result = await BillingService.getSubscription(orgId);

      expect(result).toEqual(mockSub);
    });
  });

  describe('getLocalSubscription', () => {
    test('should return local subscription without calling Stripe', async () => {
      // V6 P2: getLocalSubscription is a lightweight DB-only read, no Stripe fetch.
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_local_sub' } },
      }));

      mockStripeInstance.subscriptions = { retrieve: jest.fn() };

      const mockSub = { organization: orgId, plan: 'pro', stripeSubscriptionId: 'sub_local_999' };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(mockSub);

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const result = await BillingService.getLocalSubscription(orgId);

      expect(result).toBe(mockSub);
      expect(mockStripeInstance.subscriptions.retrieve).not.toHaveBeenCalled();
    });

    test('should return null when no subscription exists', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_local_sub_null' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const result = await BillingService.getLocalSubscription(orgId);

      expect(result).toBeNull();
    });
  });

  describe('fetchSubscriptionDetails', () => {
    test('should return mapped Stripe fields', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_fetch1' } },
      }));

      const periodEnd = Math.floor(Date.now() / 1000) + 86400;
      mockStripeInstance.subscriptions = {
        retrieve: jest.fn().mockResolvedValue({
          current_period_start: periodEnd - 2592000,
          current_period_end: periodEnd,
          cancel_at_period_end: true,
          status: 'active',
          cancel_at: null,
        }),
      };

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const result = await BillingService.fetchSubscriptionDetails('sub_test');

      expect(result).toMatchObject({
        cancelAtPeriodEnd: true,
        status: 'active',
      });
      expect(result.currentPeriodEnd).toBeInstanceOf(Date);
      expect(result.currentPeriodStart).toBeInstanceOf(Date);
      expect(result.nextRenewalDate).toBeInstanceOf(Date);
    });

    test('should return null when stripeSubscriptionId is null', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_fetch2' } },
      }));

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const result = await BillingService.fetchSubscriptionDetails(null);

      expect(result).toBeNull();
    });

    test('should use cancel_at as nextRenewalDate when set', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_fetch3' } },
      }));

      const periodEnd = Math.floor(Date.now() / 1000) + 86400;
      const cancelAt = periodEnd + 7200;
      mockStripeInstance.subscriptions = {
        retrieve: jest.fn().mockResolvedValue({
          current_period_start: periodEnd - 2592000,
          current_period_end: periodEnd,
          cancel_at_period_end: true,
          status: 'active',
          cancel_at: cancelAt,
        }),
      };

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const result = await BillingService.fetchSubscriptionDetails('sub_cancel');

      expect(result.nextRenewalDate).toEqual(new Date(cancelAt * 1000));
    });
  });
});
