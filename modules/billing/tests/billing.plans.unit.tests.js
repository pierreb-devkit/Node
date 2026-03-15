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

  const mockAllPrices = {
    data: [
      { product: 'prod_starter', recurring: { interval: 'month' }, unit_amount: 900, id: 'price_starter_m' },
      { product: 'prod_starter', recurring: { interval: 'year' }, unit_amount: 9000, id: 'price_starter_y' },
      { product: 'prod_pro', recurring: { interval: 'month' }, unit_amount: 2900, id: 'price_pro_m' },
      { product: 'prod_pro', recurring: { interval: 'year' }, unit_amount: 29000, id: 'price_pro_y' },
    ],
  };

  beforeEach(async () => {
    jest.resetModules();

    mockStripeInstance = {
      products: {
        list: jest.fn().mockResolvedValue(mockProducts),
      },
      prices: {
        list: jest.fn().mockResolvedValue(mockAllPrices),
      },
    };

    jest.unstable_mockModule('stripe', () => ({
      default: jest.fn(() => mockStripeInstance),
    }));

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

  test('should fetch plans from stripe and sort by monthlyPrice', async () => {
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
      data: [{ product: 'prod_one', unit_amount: 500, id: 'price_one' }],
    });

    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    const plans = await BillingPlansService.getPlans();
    expect(plans[0].monthlyPrice).toBe(0);
    expect(plans[0].annualPrice).toBe(0);
    expect(plans[0].stripePriceMonthly).toBeNull();
    expect(plans[0].stripePriceAnnual).toBeNull();
  });

  test('should handle null unit_amount gracefully', async () => {
    mockStripeInstance.products.list.mockResolvedValue({
      data: [{ id: 'prod_metered', name: 'Metered', metadata: { planId: 'metered' } }],
    });
    mockStripeInstance.prices.list.mockResolvedValue({
      data: [{ product: 'prod_metered', recurring: { interval: 'month' }, unit_amount: null, id: 'price_metered' }],
    });

    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    const plans = await BillingPlansService.getPlans();
    expect(plans[0].monthlyPrice).toBe(0);
    expect(plans[0].stripePriceMonthly).toBe('price_metered');
  });

  test('should fetch products and prices with limit 100', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    await BillingPlansService.getPlans();

    expect(mockStripeInstance.products.list).toHaveBeenCalledWith({ active: true, limit: 100 });
    expect(mockStripeInstance.prices.list).toHaveBeenCalledWith({ active: true, limit: 100 });
  });

  test('should only make one prices.list call regardless of product count', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    await BillingPlansService.getPlans();

    expect(mockStripeInstance.prices.list).toHaveBeenCalledTimes(1);
  });
});
