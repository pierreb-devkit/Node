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
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSub);
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
        .mockResolvedValueOnce(existingSub)
        .mockResolvedValueOnce(updatedSub);
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

    test('should use existing customer when subscription has stripeCustomerId', async () => {
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
      expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
        {
          customer: 'cus_existing',
          mode: 'subscription',
          line_items: [{ price: 'price_starter_m', quantity: 1 }],
          success_url: 'http://ok',
          cancel_url: 'http://cancel',
          automatic_tax: { enabled: true },
          metadata: {
            organizationId: orgId,
            plan: 'starter',
          },
        },
        { idempotencyKey: `sub_checkout_${orgId}_price_starter_m` },
      );
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

  describe('getSubscription', () => {
    test('should return subscription for organization', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_sub1' } },
      }));

      const mockSub = { organization: orgId, plan: 'pro' };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(mockSub);

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const result = await BillingService.getSubscription(orgId);

      expect(result).toEqual(mockSub);
      expect(mockSubscriptionRepository.findByOrganization).toHaveBeenCalledWith(orgId);
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
  });
});
