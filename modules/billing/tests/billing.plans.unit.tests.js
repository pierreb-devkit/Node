/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for billing plans service
 */
describe('Billing plans service unit tests:', () => {
  let BillingPlansService;
  let mockConfig;
  let mockStripeInstance;

  const mockProducts = {
    data: [
      {
        id: 'prod_pro',
        name: 'Pro',
        metadata: { planId: 'pro' },
      },
      {
        id: 'prod_starter',
        name: 'Starter',
        metadata: { planId: 'starter' },
      },
    ],
  };

  const mockPricesStarter = {
    data: [
      { recurring: { interval: 'month' }, unit_amount: 900, id: 'price_starter_m' },
      { recurring: { interval: 'year' }, unit_amount: 9000, id: 'price_starter_y' },
    ],
  };

  const mockPricesPro = {
    data: [
      { recurring: { interval: 'month' }, unit_amount: 2900, id: 'price_pro_m' },
      { recurring: { interval: 'year' }, unit_amount: 29000, id: 'price_pro_y' },
    ],
  };

  beforeEach(async () => {
    // Reset modules to clear cached stripe client and plans
    jest.resetModules();

    mockStripeInstance = {
      products: {
        list: jest.fn().mockResolvedValue(mockProducts),
      },
      prices: {
        list: jest.fn().mockImplementation(({ product }) => {
          if (product === 'prod_starter') return Promise.resolve(mockPricesStarter);
          if (product === 'prod_pro') return Promise.resolve(mockPricesPro);
          return Promise.resolve({ data: [] });
        }),
      },
    };

    // Mock Stripe constructor
    jest.unstable_mockModule('stripe', () => ({
      default: jest.fn(() => mockStripeInstance),
    }));

    // Mock config with stripe key
    mockConfig = {
      stripe: { secretKey: 'sk_test_123' },
    };
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should return default free plan when stripe is not configured', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: {} },
    }));

    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    const plans = await BillingPlansService.getPlans();
    expect(plans).toEqual([
      {
        planId: 'free',
        name: 'Free',
        monthlyPrice: 0,
        annualPrice: 0,
        stripePriceMonthly: null,
        stripePriceAnnual: null,
      },
    ]);
  });

  test('should return default free plan when stripe config is null', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {},
    }));

    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    const plans = await BillingPlansService.getPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0].planId).toBe('free');
  });

  test('should fetch plans from stripe and sort by price', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    const plans = await BillingPlansService.getPlans();
    expect(plans).toHaveLength(2);
    expect(plans[0].name).toBe('Starter');
    expect(plans[0].monthlyPrice).toBe(9);
    expect(plans[0].annualPrice).toBe(90);
    expect(plans[0].stripePriceMonthly).toBe('price_starter_m');
    expect(plans[0].stripePriceAnnual).toBe('price_starter_y');
    expect(plans[1].name).toBe('Pro');
    expect(plans[1].monthlyPrice).toBe(29);
  });

  test('should use planId from metadata when available', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    const plans = await BillingPlansService.getPlans();
    expect(plans[0].planId).toBe('starter');
    expect(plans[1].planId).toBe('pro');
  });

  test('should fall back to product id when metadata planId is missing', async () => {
    mockStripeInstance.products.list.mockResolvedValue({
      data: [{ id: 'prod_basic', name: 'Basic', metadata: {} }],
    });
    mockStripeInstance.prices.list.mockResolvedValue({ data: [] });

    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    const plans = await BillingPlansService.getPlans();
    expect(plans[0].planId).toBe('prod_basic');
  });

  test('should use cached plans on second call', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    await BillingPlansService.getPlans();
    await BillingPlansService.getPlans();

    expect(mockStripeInstance.products.list).toHaveBeenCalledTimes(1);
  });

  test('should handle prices without recurring interval', async () => {
    mockStripeInstance.products.list.mockResolvedValue({
      data: [{ id: 'prod_one', name: 'OneTime', metadata: { planId: 'one' } }],
    });
    mockStripeInstance.prices.list.mockResolvedValue({
      data: [{ unit_amount: 500, id: 'price_one' }],
    });

    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    const plans = await BillingPlansService.getPlans();
    expect(plans[0].monthlyPrice).toBe(0);
    expect(plans[0].annualPrice).toBe(0);
    expect(plans[0].stripePriceMonthly).toBeNull();
    expect(plans[0].stripePriceAnnual).toBeNull();
  });
});
