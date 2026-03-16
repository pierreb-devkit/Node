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

  const orgId = '507f1f77bcf86cd799439011';
  const mockOrganization = { _id: orgId, name: 'Test Org' };

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

      await expect(BillingService.createCheckout(mockOrganization, 'price_123', 'http://ok', 'http://cancel')).rejects.toThrow(
        'Stripe is not configured',
      );
    });

    test('should throw when stripe config is null', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {},
      }));

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      await expect(BillingService.createCheckout(mockOrganization, 'price_123', 'http://ok', 'http://cancel')).rejects.toThrow(
        'Stripe is not configured',
      );
    });

    test('should create customer and subscription when none exists', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_123' } },
      }));

      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockSubscriptionRepository.create.mockResolvedValue({ stripeCustomerId: 'cus_new123' });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const url = await BillingService.createCheckout(mockOrganization, 'price_123', 'http://ok', 'http://cancel');

      expect(url).toBe('https://checkout.stripe.com/session_123');
      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith({
        name: 'Test Org',
        metadata: { organizationId: orgId },
      });
      expect(mockSubscriptionRepository.create).toHaveBeenCalledWith({
        organization: orgId,
        stripeCustomerId: 'cus_new123',
      });
    });

    test('should update existing subscription without stripeCustomerId', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { stripe: { secretKey: 'sk_test_456' } },
      }));

      const existingSub = {
        _id: 'sub_existing',
        stripeCustomerId: null,
        toObject: jest.fn().mockReturnValue({ _id: 'sub_existing', stripeCustomerId: null }),
      };
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(existingSub);
      mockSubscriptionRepository.update.mockResolvedValue({ stripeCustomerId: 'cus_new123' });

      const mod = await import('../services/billing.service.js');
      BillingService = mod.default;

      const url = await BillingService.createCheckout(mockOrganization, 'price_123', 'http://ok', 'http://cancel');

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

      const url = await BillingService.createCheckout(mockOrganization, 'price_123', 'http://ok', 'http://cancel');

      expect(url).toBe('https://checkout.stripe.com/session_123');
      expect(mockStripeInstance.customers.create).not.toHaveBeenCalled();
      expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith({
        customer: 'cus_existing',
        mode: 'subscription',
        line_items: [{ price: 'price_123', quantity: 1 }],
        success_url: 'http://ok',
        cancel_url: 'http://cancel',
      });
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

    test('should return portal session URL when customer exists', async () => {
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
