/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Helper to create a mock Stripe list result with autoPagingToArray
 */
const mockListResult = (data) => ({
  autoPagingToArray: jest.fn().mockResolvedValue(data),
});

/**
 * Unit tests for billing plans service
 */
describe('Billing plans service unit tests:', () => {
  let BillingPlansService;
  let mockConfig;
  let mockStripeInstance;

  const productsData = [
    { id: 'prod_pro', name: 'Pro', metadata: { planId: 'pro' } },
    { id: 'prod_starter', name: 'Starter', metadata: { planId: 'starter' } },
  ];

  const pricesData = [
    { product: 'prod_starter', recurring: { interval: 'month' }, unit_amount: 900, id: 'price_starter_m' },
    { product: 'prod_starter', recurring: { interval: 'year' }, unit_amount: 9000, id: 'price_starter_y' },
    { product: 'prod_pro', recurring: { interval: 'month' }, unit_amount: 2900, id: 'price_pro_m' },
    { product: 'prod_pro', recurring: { interval: 'year' }, unit_amount: 29000, id: 'price_pro_y' },
  ];

  beforeEach(async () => {
    jest.resetModules();

    mockStripeInstance = {
      products: {
        list: jest.fn().mockReturnValue(mockListResult(productsData)),
      },
      prices: {
        list: jest.fn().mockReturnValue(mockListResult(pricesData)),
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

    // Mock logger to avoid real winston initialisation (requires full config.log)
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }));

    // Mock events to avoid real EventEmitter side effects
    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
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
    mockStripeInstance.products.list.mockReturnValue(mockListResult([{ id: 'prod_basic', name: 'Basic', metadata: {} }]));
    mockStripeInstance.prices.list.mockReturnValue(mockListResult([]));

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
    mockStripeInstance.products.list.mockReturnValue(
      mockListResult([{ id: 'prod_one', name: 'OneTime', metadata: { planId: 'one' } }]),
    );
    mockStripeInstance.prices.list.mockReturnValue(
      mockListResult([{ product: 'prod_one', unit_amount: 500, id: 'price_one' }]),
    );

    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    const plans = await BillingPlansService.getPlans();
    expect(plans[0].monthlyPrice).toBe(0);
    expect(plans[0].annualPrice).toBe(0);
    expect(plans[0].stripePriceMonthly).toBeNull();
    expect(plans[0].stripePriceAnnual).toBeNull();
  });

  test('should handle null unit_amount gracefully', async () => {
    mockStripeInstance.products.list.mockReturnValue(
      mockListResult([{ id: 'prod_metered', name: 'Metered', metadata: { planId: 'metered' } }]),
    );
    mockStripeInstance.prices.list.mockReturnValue(
      mockListResult([{ product: 'prod_metered', recurring: { interval: 'month' }, unit_amount: null, id: 'price_metered' }]),
    );

    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    const plans = await BillingPlansService.getPlans();
    expect(plans[0].monthlyPrice).toBe(0);
    expect(plans[0].stripePriceMonthly).toBe('price_metered');
  });

  test('should use autoPagingToArray for products and prices', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    await BillingPlansService.getPlans();

    expect(mockStripeInstance.products.list).toHaveBeenCalledWith({ active: true });
    expect(mockStripeInstance.prices.list).toHaveBeenCalledWith({ active: true });
  });

  test('should only make one prices.list call regardless of product count', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    await BillingPlansService.getPlans();

    expect(mockStripeInstance.prices.list).toHaveBeenCalledTimes(1);
  });

  test('should refresh cache after FRESH_TTL expires (5 minutes)', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    await BillingPlansService.getPlans();

    // Advance time past FRESH_TTL (5 minutes)
    const originalDateNow = Date.now;
    Date.now = jest.fn().mockReturnValue(originalDateNow() + 6 * 60 * 1000);

    await BillingPlansService.getPlans();

    expect(mockStripeInstance.products.list).toHaveBeenCalledTimes(2);

    Date.now = originalDateNow;
  });

  // ── Facade regression — billing.plans.service.js public API ────────────
  // These tests ensure the legacy service still exports the same interface
  // after the introduction of billing.plan.service.js (the new versioned service).

  test('facade: getPlans should be a function (API contract unchanged)', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    expect(typeof BillingPlansService.getPlans).toBe('function');
  });

  test('facade: fetchPlansFromStripe should NOT be exported from default facade', async () => {
    const mod = await import('../services/billing.plans.service.js');
    // fetchPlansFromStripe is intentionally NOT re-exported (it's an internal helper)
    // Verify that the default export only exposes the public surface: getPlans
    expect(typeof mod.default.getPlans).toBe('function');
    expect(mod.default.fetchPlansFromStripe).toBeUndefined();
  });

  // ── In-flight dedup — Stripe-API-quota DoS hardening ────────────────────
  // The /api/billing/plans route is public, so a thundering herd on cache miss
  // (or a small DoS) would otherwise fire N parallel `stripe.products.list +
  // stripe.prices.list` calls and exhaust the Stripe API quota — breaking live
  // checkouts and webhook signature verification. The service layer dedups
  // concurrent in-flight fetches into a single Stripe round-trip.

  test('100 concurrent getPlans() calls during cache miss → exactly ONE Stripe products.list call', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    // Resolve manually so all 100 callers race the same in-flight promise.
    let resolveProducts;
    mockStripeInstance.products.list.mockReturnValue({
      autoPagingToArray: jest.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveProducts = () => resolve(productsData);
        }),
      ),
    });

    const inflight = Array.from({ length: 100 }, () => BillingPlansService.getPlans());

    // Resolve the underlying Stripe call once — all 100 callers should share its result.
    resolveProducts();
    const results = await Promise.all(inflight);

    expect(mockStripeInstance.products.list).toHaveBeenCalledTimes(1);
    expect(mockStripeInstance.prices.list).toHaveBeenCalledTimes(1);
    // Every caller gets the same plan list.
    for (const plans of results) expect(plans).toHaveLength(2);
  });

  test('after cache TTL expires, a fresh thundering herd still triggers ONE fetch', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    // First call populates the cache.
    await BillingPlansService.getPlans();
    expect(mockStripeInstance.products.list).toHaveBeenCalledTimes(1);

    // Advance time past FRESH_TTL (5 minutes).
    const originalDateNow = Date.now;
    Date.now = jest.fn().mockReturnValue(originalDateNow() + 6 * 60 * 1000);

    // 50 concurrent callers after TTL expires.
    let resolveProducts;
    mockStripeInstance.products.list.mockReturnValue({
      autoPagingToArray: jest.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveProducts = () => resolve(productsData);
        }),
      ),
    });

    const inflight = Array.from({ length: 50 }, () => BillingPlansService.getPlans());
    resolveProducts();
    await Promise.all(inflight);

    // Total: 1 (initial) + 1 (after TTL) — not 1 + 50.
    expect(mockStripeInstance.products.list).toHaveBeenCalledTimes(2);

    Date.now = originalDateNow;
  });

  test('in-flight slot resets after fetch failure with no stale cache → throws', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    // First fetch fails with no stale cache — must throw (no fallback available).
    mockStripeInstance.products.list.mockReturnValueOnce({
      autoPagingToArray: jest.fn().mockRejectedValue(new Error('Stripe API down')),
    });

    await expect(BillingPlansService.getPlans()).rejects.toThrow('Stripe API down');

    // Second call should issue a NEW Stripe round-trip (slot was cleared in finally).
    mockStripeInstance.products.list.mockReturnValueOnce(mockListResult(productsData));
    mockStripeInstance.prices.list.mockReturnValueOnce(mockListResult(pricesData));

    const plans = await BillingPlansService.getPlans();
    expect(plans).toHaveLength(2);
    expect(mockStripeInstance.products.list).toHaveBeenCalledTimes(2);
  });

  // ── Stale-while-revalidate — Stripe outage resilience ───────────────────
  // getPlans() must not throw when Stripe is down, provided a stale cache
  // was populated within the last 24h (STALE_TTL). This prevents the public
  // plans endpoint from surfacing 500s during transient Stripe outages.

  test('Stripe down after successful fetch → returns stale cache, does not throw', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    // Get the mock emit function from the mocked events module
    const eventsMod = await import('../lib/events.js');
    const mockBillingEventsEmit = eventsMod.default.emit;

    // First call succeeds — populates stale snapshot
    const freshPlans = await BillingPlansService.getPlans();
    expect(freshPlans).toHaveLength(2);

    // Advance time past FRESH_TTL so the next call hits Stripe
    const originalDateNow = Date.now;
    Date.now = jest.fn().mockReturnValue(originalDateNow() + 6 * 60 * 1000);

    // Stripe is now down
    mockStripeInstance.products.list.mockReturnValueOnce({
      autoPagingToArray: jest.fn().mockRejectedValue(new Error('Stripe API down')),
    });

    // Should return stale data instead of throwing
    const stalePlansResult = await BillingPlansService.getPlans();
    expect(stalePlansResult).toHaveLength(2);
    expect(stalePlansResult[0].planId).toBe('starter');

    // Should have emitted billing.plans.stale
    expect(mockBillingEventsEmit).toHaveBeenCalledWith('billing.plans.stale', expect.objectContaining({ staleAgeMs: expect.any(Number) }));

    Date.now = originalDateNow;
  });

  test('Stripe down with stale cache expired (> 24h) → throws', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    // First call succeeds — populates stale snapshot
    await BillingPlansService.getPlans();

    // Advance time past STALE_TTL (24h)
    const originalDateNow = Date.now;
    Date.now = jest.fn().mockReturnValue(originalDateNow() + 25 * 60 * 60 * 1000);

    // Stripe is now down
    mockStripeInstance.products.list.mockReturnValueOnce({
      autoPagingToArray: jest.fn().mockRejectedValue(new Error('Stripe API down after stale TTL')),
    });

    // Stale TTL exceeded → must throw, not silently serve very old data
    await expect(BillingPlansService.getPlans()).rejects.toThrow('Stripe API down after stale TTL');

    Date.now = originalDateNow;
  });

  test('facade: getPlans returns array of plan objects', async () => {
    const mod = await import('../services/billing.plans.service.js');
    BillingPlansService = mod.default;

    const plans = await BillingPlansService.getPlans();
    expect(Array.isArray(plans)).toBe(true);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(plan).toHaveProperty('planId');
      expect(plan).toHaveProperty('monthlyPrice');
    }
  });
});
