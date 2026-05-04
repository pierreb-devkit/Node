/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for BillingService.createExtrasCheckout
 */
describe('BillingService.createExtrasCheckout unit tests:', () => {
  let BillingService;
  let mockStripeInstance;
  let mockSubscriptionRepository;

  const orgId = '507f1f77bcf86cd799439011';
  const mockOrganization = { _id: orgId, name: 'Test Org' };

  /**
   * @param {Object} [stripe={}] - stripe config overrides.
   * @returns {Object} A billing config stub with packs and stripe prices.
   */
  const makeConfig = (stripe = {}) => ({
    billing: {
      plans: ['free', 'starter', 'pro'],
      packs: [
        { packId: 'pack_500k', meterUnits: 500000, priceUsd: 49 },
        { packId: 'pack_2m', meterUnits: 2000000, priceUsd: 149 },
      ],
    },
    stripe: {
      secretKey: 'sk_test_abc',
      prices: {
        packs: {
          pack_500k: 'price_pack500k',
          pack_2m: 'price_pack2m',
        },
        ...stripe,
      },
    },
  });

  beforeEach(async () => {
    jest.resetModules();

    mockStripeInstance = {
      customers: {
        create: jest.fn().mockResolvedValue({ id: 'cus_new123' }),
      },
      checkout: {
        sessions: {
          create: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/session_extras' }),
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

  test('should throw when Stripe is not configured', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: {} },
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;

    await expect(
      BillingService.createExtrasCheckout(mockOrganization, 'pack_500k', 'http://ok', 'http://cancel'),
    ).rejects.toThrow('Stripe is not configured');
  });

  test('should throw when packId not found in config', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: makeConfig(),
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;

    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: 'cus_existing' });

    await expect(
      BillingService.createExtrasCheckout(mockOrganization, 'pack_unknown', 'http://ok', 'http://cancel'),
    ).rejects.toThrow('Invalid packId: pack not found: pack_unknown');
  });

  test('should throw when no Stripe price configured for packId', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: {
          plans: ['free'],
          packs: [{ packId: 'pack_500k', meterUnits: 500000 }],
        },
        stripe: { secretKey: 'sk_test_abc', prices: { packs: {} } },
      },
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;

    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: 'cus_existing' });

    await expect(
      BillingService.createExtrasCheckout(mockOrganization, 'pack_500k', 'http://ok', 'http://cancel'),
    ).rejects.toThrow('Invalid packId: no Stripe price configured for pack: pack_500k');
  });

  test('should throw on invalid successUrl', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: makeConfig(),
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;

    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: 'cus_existing' });

    await expect(
      BillingService.createExtrasCheckout(mockOrganization, 'pack_500k', 'not-a-url', 'http://cancel'),
    ).rejects.toThrow('Invalid redirect URL');
  });

  test('should call Stripe with mode=payment and correct args when subscription exists', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: makeConfig(),
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;

    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: 'cus_existing' });

    const result = await BillingService.createExtrasCheckout(
      mockOrganization, 'pack_500k', 'http://success', 'http://cancel',
    );

    expect(result).toEqual({ url: 'https://checkout.stripe.com/session_extras' });
    expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_existing',
        mode: 'payment',
        line_items: [{ price: 'price_pack500k', quantity: 1 }],
        metadata: expect.objectContaining({
          organizationId: orgId,
          packId: 'pack_500k',
          kind: 'extras',
        }),
        payment_intent_data: {
          metadata: expect.objectContaining({
            organizationId: orgId,
            packId: 'pack_500k',
            kind: 'extras',
          }),
        },
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('extras_checkout_') }),
    );
  });

  test('should include idempotencyKey in Stripe call', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: makeConfig(),
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;

    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: 'cus_existing' });

    await BillingService.createExtrasCheckout(
      mockOrganization, 'pack_2m', 'http://success', 'http://cancel',
    );

    const [, options] = mockStripeInstance.checkout.sessions.create.mock.calls[0];
    // No intentId passed → minute-bucketed key (no random hex suffix)
    expect(options.idempotencyKey).toMatch(/^extras_checkout_.*pack_2m_\d+$/);
  });

  test('should set stripeSessionId to __pending__ in metadata', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: makeConfig(),
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;

    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: 'cus_existing' });

    await BillingService.createExtrasCheckout(
      mockOrganization, 'pack_500k', 'http://success', 'http://cancel',
    );

    const [params] = mockStripeInstance.checkout.sessions.create.mock.calls[0];
    expect(params.metadata.stripeSessionId).toBe('__pending__');
    expect(params.payment_intent_data.metadata.stripeSessionId).toBe('__pending__');
  });

  test('should create Stripe customer when subscription has no stripeCustomerId', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: makeConfig(),
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;

    mockSubscriptionRepository.findByOrganization
      .mockResolvedValueOnce(null)       // initial lookup
      .mockResolvedValueOnce({ stripeCustomerId: 'cus_new123' }); // re-read after create

    mockSubscriptionRepository.create.mockResolvedValue({ organization: orgId, stripeCustomerId: 'cus_new123' });

    await BillingService.createExtrasCheckout(
      mockOrganization, 'pack_500k', 'http://success', 'http://cancel',
    );

    expect(mockStripeInstance.customers.create).toHaveBeenCalledWith(
      { name: 'Test Org', metadata: { organizationId: orgId } },
      { idempotencyKey: `cus_create_${orgId}` },
    );
    expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalled();
  });

  test('should NOT include customer_update when automaticTax flag is off (default)', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: makeConfig(),
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;

    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: 'cus_existing' });

    await BillingService.createExtrasCheckout(
      mockOrganization, 'pack_500k', 'http://success', 'http://cancel',
    );

    const [params] = mockStripeInstance.checkout.sessions.create.mock.calls[0];
    expect(params.customer_update).toBeUndefined();
    expect(params.automatic_tax).toBeUndefined();
  });

  test('should include customer_update and automatic_tax when automaticTax flag is on', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        ...makeConfig(),
        stripe: {
          ...makeConfig().stripe,
          automaticTax: true,
        },
      },
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;

    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ stripeCustomerId: 'cus_existing' });

    await BillingService.createExtrasCheckout(
      mockOrganization, 'pack_500k', 'http://success', 'http://cancel',
    );

    const [params] = mockStripeInstance.checkout.sessions.create.mock.calls[0];
    expect(params.customer_update).toEqual({ address: 'auto', name: 'auto' });
    expect(params.automatic_tax).toEqual({ enabled: true });
  });

  test('should handle 11000 duplicate key on subscription create gracefully', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: makeConfig(),
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;

    mockSubscriptionRepository.findByOrganization
      .mockResolvedValueOnce(null)       // initial lookup — no subscription
      .mockResolvedValueOnce({ stripeCustomerId: 'cus_race' }); // re-read after dup error

    const dupErr = new Error('duplicate key');
    dupErr.code = 11000;
    mockSubscriptionRepository.create.mockRejectedValue(dupErr);

    await BillingService.createExtrasCheckout(
      mockOrganization, 'pack_500k', 'http://success', 'http://cancel',
    );

    expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_race' }),
      expect.any(Object),
    );
  });
});
