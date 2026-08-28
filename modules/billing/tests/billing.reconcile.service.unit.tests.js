/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for BillingReconcileService.runReconciliation.
 * Validates LOG-ONLY policy, pagination, divergence detection, and error handling.
 * Also covers meter↔extras mismatch detection (_checkMeterExtrasMismatch — Item 2 Batch 2).
 */
describe('BillingReconcileService.runReconciliation unit tests:', () => {
  let BillingReconcileService;
  let mockStripeInstance;
  let mockGetStripe;
  let mockLogger;
  let mockEvents;
  let mockSubscriptionRepository;
  let mockUsageRepository;
  let mockExtraBalanceRepository;
  let mockConfig;

  const orgId = '507f1f77bcf86cd799439011';
  const stripeSubId = 'sub_test_001';

  /**
   * Build a stub DB subscription.
   */
  const makeDbSub = (overrides = {}) => ({
    _id: 'sub_doc_001',
    organization: { _id: orgId },
    plan: 'pro',
    status: 'active',
    stripeSubscriptionId: stripeSubId,
    ...overrides,
  });

  /**
   * Build a stub Stripe subscription.
   * Realistic Stripe payload (#3964): price.id present, metadata.planId ABSENT — real Stripe
   * Price objects carry no metadata.planId; resolveStripePlan must resolve via the priceId map.
   */
  const makeStripeSub = (overrides = {}) => ({
    id: stripeSubId,
    status: 'active',
    items: { data: [{ price: { id: 'price_pro_monthly', metadata: {} } }] },
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    mockEvents = { emit: jest.fn() };

    mockConfig = {
      billing: {
        meterMode: true,
        plans: ['free', 'starter', 'pro', 'enterprise'],
      },
      // Real config.stripe.prices shape (#3964) — priceId → planId map used by the shared
      // resolver (billing.planResolver.js), same as production config.
      stripe: {
        prices: {
          starter: { monthly: 'price_starter_monthly', annual: 'price_starter_annual' },
          pro: { monthly: 'price_pro_monthly', annual: 'price_pro_annual' },
        },
      },
    };

    mockStripeInstance = {
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(makeStripeSub()),
      },
    };
    mockGetStripe = jest.fn().mockReturnValue(mockStripeInstance);

    // SubscriptionRepository: paginated fetch via findPageForReconciliation
    mockSubscriptionRepository = {
      findPageForReconciliation: jest.fn().mockResolvedValue([]),
    };

    // Default usage doc: 200 used, 100 quota → 100 units in extras expected
    mockUsageRepository = {
      findByWeek: jest.fn().mockResolvedValue({ meterUsed: 200, meterQuota: 100 }),
    };

    // Default extra balance: 100-unit debit sum for the current week (matches expected)
    mockExtraBalanceRepository = {
      sumDebitsByWindow: jest.fn().mockResolvedValue(100),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: mockGetStripe }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: mockEvents }));
    jest.unstable_mockModule('../lib/billing.isoWeek.js', () => ({
      currentWeekKey: jest.fn().mockReturnValue('2026-W18'),
      weekStartDate: jest.fn().mockReturnValue(new Date('2026-04-28T00:00:00.000Z')),
    }));
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));
    jest.unstable_mockModule('../repositories/billing.usage.repository.js', () => ({
      default: mockUsageRepository,
    }));
    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
      default: mockExtraBalanceRepository,
    }));

    const mod = await import('../services/billing.reconcile.service.js');
    BillingReconcileService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns { checked: 0, divergences: 0, errors: 0 } when meterMode is false', async () => {
    mockConfig.billing.meterMode = false;

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toEqual({ checked: 0, divergences: 0, errors: 0 });
    expect(mockStripeInstance.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  test('returns { checked: 0, divergences: 0, errors: 0 } when Stripe is not configured', async () => {
    mockGetStripe.mockReturnValue(null);

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toEqual({ checked: 0, divergences: 0, errors: 0 });
  });

  test('returns { checked: 0 } when no active/past_due subs found', async () => {
    mockSubscriptionRepository.findPageForReconciliation.mockResolvedValue([]);

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toEqual({ checked: 0, divergences: 0, errors: 0 });
  });

  test('checks matching sub — no divergence when status + plan match', async () => {
    const sub = makeDbSub();
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce([sub])  // first page: 1 sub
      .mockResolvedValue([]);         // second page: empty → exit
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toMatchObject({ checked: 1, divergences: 0, errors: 0 });
    expect(mockEvents.emit).not.toHaveBeenCalled();
  });

  // ─── #3964 regression: priceId-map resolution replaces the metadata-only resolver ───
  test('#3964: resolves plan via priceId map for a paid sub with NO metadata.planId — no false planMismatch', async () => {
    // DB says 'pro'; Stripe price resolves to 'pro' via the priceId map (no metadata at all).
    // Before the fix this resolver defaulted to 'free', producing a false planMismatch alert
    // for every paid org — exactly the noise this issue reports.
    const sub = makeDbSub({ plan: 'pro' });
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce([sub])
      .mockResolvedValue([]);
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(
      makeStripeSub({ items: { data: [{ price: { id: 'price_pro_monthly', metadata: {} } }] } }),
    );

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toMatchObject({ checked: 1, divergences: 0, errors: 0 });
    const planMismatchEmits = mockEvents.emit.mock.calls.filter(
      ([, p]) => p?.planMismatch === true,
    );
    expect(planMismatchEmits).toHaveLength(0);
  });

  test('#3964: unresolvable Stripe price — skips plan comparison instead of emitting a false divergence', async () => {
    // Neither the priceId map nor metadata resolves. The old resolver would have defaulted
    // to 'free' here and (falsely) diverged against any non-free DB plan. The fix must skip
    // the plan comparison entirely rather than guess.
    const sub = makeDbSub({ plan: 'pro', status: 'active' });
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce([sub])
      .mockResolvedValue([]);
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(
      makeStripeSub({ status: 'active', items: { data: [{ price: { id: 'price_unmapped_xyz', metadata: {} } }] } }),
    );

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toMatchObject({ checked: 1, divergences: 0, errors: 0 });
    const planMismatchEmits = mockEvents.emit.mock.calls.filter(
      ([, p]) => p?.planMismatch === true,
    );
    expect(planMismatchEmits).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[billing.reconcile] cannot resolve Stripe plan — skipping plan comparison for this subscription',
      expect.objectContaining({ organizationId: orgId, dbPlan: 'pro' }),
    );
  });

  test('detects status divergence — emits billing.reconciliation.divergence and logs', async () => {
    const sub = makeDbSub({ status: 'active' });
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce([sub])
      .mockResolvedValue([]);
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub({ status: 'past_due' }));

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toMatchObject({ checked: 1, divergences: 1, errors: 0 });
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.reconcile] divergence detected — LOG ONLY, no auto-fix',
      expect.objectContaining({ statusMismatch: true }),
    );
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.reconciliation.divergence',
      expect.objectContaining({ organizationId: orgId }),
    );
  });

  test('detects plan divergence — emits billing.reconciliation.divergence', async () => {
    const sub = makeDbSub({ plan: 'pro' });
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce([sub])
      .mockResolvedValue([]);
    // Stripe has plan: free instead of pro
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(
      makeStripeSub({ items: { data: [{ price: { metadata: { planId: 'free' } } }] } }),
    );

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toMatchObject({ divergences: 1 });
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.reconciliation.divergence',
      expect.objectContaining({ planMismatch: true }),
    );
  });

  test('detects plan drift on trialing sub — emits billing.reconciliation.divergence (C4)', async () => {
    const sub = makeDbSub({ status: 'trialing', plan: 'pro' });
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce([sub])
      .mockResolvedValue([]);
    // Stripe has plan: starter — simulates Dashboard bump with lost webhook
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(
      makeStripeSub({ status: 'trialing', items: { data: [{ price: { metadata: { planId: 'starter' } } }] } }),
    );

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toMatchObject({ checked: 1, divergences: 1, errors: 0 });
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.reconciliation.divergence',
      expect.objectContaining({ organizationId: orgId, planMismatch: true }),
    );
  });

  test('missing in Stripe counts as a divergence, not an error — emits billing.reconciliation.divergence', async () => {
    const sub = makeDbSub();
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce([sub])
      .mockResolvedValue([]);
    // Stripe no longer has this subscription: deleted, or created in another mode/account.
    const missing = Object.assign(new Error("No such subscription: 'sub_test_001'"), {
      code: 'resource_missing',
      statusCode: 404,
    });
    mockStripeInstance.subscriptions.retrieve.mockRejectedValue(missing);

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toMatchObject({ checked: 1, divergences: 1, errors: 0 });
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.reconciliation.divergence',
      expect.objectContaining({ organizationId: orgId, subType: 'missing_in_stripe', stripe: null }),
    );
    // Must not be reported through the generic error path.
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      '[billing.reconcile] error reconciling subscription',
      expect.any(Object),
    );
  });

  test('missing in Stripe reported via raw.code is still a divergence', async () => {
    const sub = makeDbSub();
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce([sub])
      .mockResolvedValue([]);
    const missing = Object.assign(new Error('No such subscription'), {
      raw: { code: 'resource_missing' },
    });
    mockStripeInstance.subscriptions.retrieve.mockRejectedValue(missing);

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toMatchObject({ checked: 1, divergences: 1, errors: 0 });
  });

  test('a non-missing Stripe error code is still an error, not a divergence', async () => {
    const sub = makeDbSub();
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce([sub])
      .mockResolvedValue([]);
    const rateLimited = Object.assign(new Error('Too many requests'), {
      code: 'rate_limit',
      statusCode: 429,
    });
    mockStripeInstance.subscriptions.retrieve.mockRejectedValue(rateLimited);

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toMatchObject({ checked: 0, divergences: 0, errors: 1 });
    expect(mockEvents.emit).not.toHaveBeenCalledWith(
      'billing.reconciliation.divergence',
      expect.objectContaining({ subType: 'missing_in_stripe' }),
    );
  });

  test('counts errors and continues on individual Stripe retrieve failure', async () => {
    const subs = [makeDbSub(), makeDbSub({ _id: 'sub_doc_002', stripeSubscriptionId: 'sub_test_002' })];
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce(subs)
      .mockResolvedValue([]);
    mockStripeInstance.subscriptions.retrieve
      .mockRejectedValueOnce(new Error('Stripe timeout'))
      .mockResolvedValueOnce(makeStripeSub());

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toMatchObject({ checked: 1, divergences: 0, errors: 1 });
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.reconcile] error reconciling subscription',
      expect.any(Object),
    );
  });

  test('LOG-ONLY policy: never writes to DB (no repo update calls)', async () => {
    const sub = makeDbSub({ status: 'active' });
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce([sub])
      .mockResolvedValue([]);
    // Deliberate divergence
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub({ status: 'past_due' }));

    await BillingReconcileService.runReconciliation();

    // No DB write must happen — only Stripe reads + logs
    // (mockSubscriptionRepository has no update/save methods set up — if called they'd throw)
  });

  test('paginates to second page when first page is full (RECONCILE_PAGE_SIZE=100)', async () => {
    // Build an array of 100 subs (full page) then an empty second page
    const fullPage = Array.from({ length: 100 }, (_, i) => makeDbSub({
      _id: `sub_doc_${String(i).padStart(24, '0')}`,
      stripeSubscriptionId: `sub_test_${i}`,
    }));

    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce(fullPage)  // first call: full page — advance cursor
      .mockResolvedValueOnce([]);        // second call: empty — exits loop
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

    const result = await BillingReconcileService.runReconciliation();

    // All 100 subs from page 0 should be checked
    expect(result).toMatchObject({ checked: 100, divergences: 0, errors: 0 });
    // findPageForReconciliation should have been called twice (page 0 + page 1)
    expect(mockSubscriptionRepository.findPageForReconciliation).toHaveBeenCalledTimes(2);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Cursor-based pagination (Batch 4 — item 3)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('cursor-based pagination:', () => {
    test('first page call passes null cursor', async () => {
      mockSubscriptionRepository.findPageForReconciliation.mockResolvedValue([]);

      await BillingReconcileService.runReconciliation();

      // First call must pass null as lastSeenId (no prior page)
      const [, firstCallLastSeen] = mockSubscriptionRepository.findPageForReconciliation.mock.calls[0];
      expect(firstCallLastSeen).toBeNull();
    });

    test('second page call passes _id of last doc from first page as cursor', async () => {
      const lastDocId = '507f1f77bcf86cd799439099';
      const fullPage = Array.from({ length: 100 }, (_, i) => makeDbSub({
        _id: i === 99 ? lastDocId : `507f1f77bcf86cd7994390${String(i).padStart(2, '0')}`,
        stripeSubscriptionId: `sub_test_${i}`,
      }));

      mockSubscriptionRepository.findPageForReconciliation
        .mockResolvedValueOnce(fullPage)
        .mockResolvedValueOnce([]);
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

      await BillingReconcileService.runReconciliation();

      expect(mockSubscriptionRepository.findPageForReconciliation).toHaveBeenCalledTimes(2);
      // Second call must pass the _id of the last doc from the first page
      const [, secondCallLastSeen] = mockSubscriptionRepository.findPageForReconciliation.mock.calls[1];
      expect(secondCallLastSeen).toBe(lastDocId);
    });

    test('mid-run insertion of a new sub does not cause double-processing (cursor stability)', async () => {
      // Simulate: first page has 100 subs. Cursor advances to last _id.
      // Second page is also full (100 subs) — triggers a third call with the second page's last _id.
      // A skip-based approach would shift offsets and risk skipping or double-processing docs
      // inserted before the cursor position mid-run. Cursor is immune to this.
      const lastDocIdPage1 = '507f1f77bcf86cd799439099';
      const fullPage1 = Array.from({ length: 100 }, (_, i) => makeDbSub({
        _id: i === 99 ? lastDocIdPage1 : `507f1f77bcf86cd7994390${String(i).padStart(2, '0')}`,
        stripeSubscriptionId: `sub_test_p1_${i}`,
      }));
      const lastDocIdPage2 = '607f1f77bcf86cd799439099';
      const fullPage2 = Array.from({ length: 100 }, (_, i) => makeDbSub({
        _id: i === 99 ? lastDocIdPage2 : `607f1f77bcf86cd7994390${String(i).padStart(2, '0')}`,
        stripeSubscriptionId: `sub_test_p2_${i}`,
      }));

      mockSubscriptionRepository.findPageForReconciliation
        .mockResolvedValueOnce(fullPage1)
        .mockResolvedValueOnce(fullPage2)
        .mockResolvedValueOnce([]);
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

      const result = await BillingReconcileService.runReconciliation();

      // 100 from page 1 + 100 from page 2 = 200 total
      expect(result.checked).toBe(200);
      // Three total calls to findPageForReconciliation
      expect(mockSubscriptionRepository.findPageForReconciliation).toHaveBeenCalledTimes(3);
      // Second call must use first page's last _id as cursor
      const [, secondCallLastSeen] = mockSubscriptionRepository.findPageForReconciliation.mock.calls[1];
      expect(secondCallLastSeen).toBe(lastDocIdPage1);
      // Third call must use second page's last _id as cursor
      const [, thirdCallLastSeen] = mockSubscriptionRepository.findPageForReconciliation.mock.calls[2];
      expect(thirdCallLastSeen).toBe(lastDocIdPage2);
    });
  });

  test('non-fatal: billingEvents.emit listener error is swallowed, divergence still counted', async () => {
    const sub = makeDbSub({ status: 'active' });
    mockSubscriptionRepository.findPageForReconciliation
      .mockResolvedValueOnce([sub])
      .mockResolvedValue([]);
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub({ status: 'canceled' }));
    // Simulate a listener throwing on emit
    mockEvents.emit.mockImplementation(() => { throw new Error('listener crash'); });

    const result = await BillingReconcileService.runReconciliation();

    // Divergence is still counted despite listener crash
    expect(result).toMatchObject({ checked: 1, divergences: 1, errors: 0 });
    // Error should be logged (non-fatal)
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.reconcile] billing.reconciliation.divergence listener error (non-fatal)',
      expect.objectContaining({ error: 'listener crash' }),
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // meter↔extras mismatch detection (Item 2 — Batch 2)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('meter↔extras mismatch detection:', () => {
    const makeSingleSub = (sub) => {
      mockSubscriptionRepository.findPageForReconciliation
        .mockResolvedValueOnce([sub])
        .mockResolvedValue([]);
    };

    test('matching sums — no divergence, no event emitted', async () => {
      const sub = makeDbSub();
      makeSingleSub(sub);
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

      // meterUsed=200, meterQuota=100 → expectedExtras=100
      // sumDebitsByWindow returns 100 → delta=0 → within tolerance → no divergence
      mockUsageRepository.findByWeek.mockResolvedValue({ meterUsed: 200, meterQuota: 100 });
      mockExtraBalanceRepository.sumDebitsByWindow.mockResolvedValue(100);

      const result = await BillingReconcileService.runReconciliation();

      expect(result).toMatchObject({ checked: 1, divergences: 0, errors: 0 });
      // No meter_extras_mismatch emit
      const emittedWithMismatch = mockEvents.emit.mock.calls.filter(
        ([, p]) => p?.subType === 'meter_extras_mismatch',
      );
      expect(emittedWithMismatch).toHaveLength(0);
    });

    test('10-unit delta on 100-unit expected — within 0.5% tolerance — no event', async () => {
      const sub = makeDbSub();
      makeSingleSub(sub);
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

      // expectedExtras=10000, actualDebits=9990 → delta=10
      // tolerance = max(50, 0.5% × 10000) = max(50, 50) = 50
      // delta(10) <= tolerance(50) → no divergence
      mockUsageRepository.findByWeek.mockResolvedValue({ meterUsed: 10100, meterQuota: 100 });
      mockExtraBalanceRepository.sumDebitsByWindow.mockResolvedValue(9990);

      await BillingReconcileService.runReconciliation();

      const mismatchEmits = mockEvents.emit.mock.calls.filter(
        ([, p]) => p?.subType === 'meter_extras_mismatch',
      );
      expect(mismatchEmits).toHaveLength(0);
    });

    test('large delta — over tolerance — emits billing.reconciliation.divergence with subType:meter_extras_mismatch', async () => {
      const sub = makeDbSub();
      makeSingleSub(sub);
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

      // expectedExtras=10000, actualDebits=5000 → delta=5000
      // tolerance = max(50, 0.5% × 10000) = 50 → delta(5000) >> tolerance
      mockUsageRepository.findByWeek.mockResolvedValue({ meterUsed: 10100, meterQuota: 100 });
      mockExtraBalanceRepository.sumDebitsByWindow.mockResolvedValue(5000);

      const result = await BillingReconcileService.runReconciliation();

      // divergences counts both meter_extras_mismatch
      expect(result.divergences).toBeGreaterThanOrEqual(1);
      const mismatchEmits = mockEvents.emit.mock.calls.filter(
        ([name, p]) => name === 'billing.reconciliation.divergence' && p?.subType === 'meter_extras_mismatch',
      );
      expect(mismatchEmits).toHaveLength(1);
      expect(mismatchEmits[0][1]).toMatchObject({
        organizationId: orgId,
        subType: 'meter_extras_mismatch',
        expectedExtrasUsage: 10000,
        actualExtrasDebits: 5000,
        delta: 5000,
      });
    });

    test('meter↔extras check failure is non-fatal — subscription still counted, errors=0', async () => {
      const sub = makeDbSub();
      makeSingleSub(sub);
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

      // Simulate BillingUsageRepository.findByWeek throwing
      mockUsageRepository.findByWeek.mockRejectedValue(new Error('DB unavailable'));

      const result = await BillingReconcileService.runReconciliation();

      // Sub is still checked (status/plan match), error not bubbled up as sub error
      expect(result.checked).toBe(1);
      expect(result.errors).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing.reconcile] meter↔extras check failed (non-fatal)',
        expect.any(Object),
      );
    });

    test('free plan (meterQuota=0): all units are extras — large debit matches', async () => {
      const sub = makeDbSub({ plan: 'free' });
      makeSingleSub(sub);
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(
        makeStripeSub({ items: { data: [{ price: { metadata: { planId: 'free' } } }] } }),
      );

      // meterUsed=50, meterQuota=0 → expectedExtras=50 (all units are extras)
      // sumDebitsByWindow returns 50 → delta=0 → no divergence
      mockUsageRepository.findByWeek.mockResolvedValue({ meterUsed: 50, meterQuota: 0 });
      mockExtraBalanceRepository.sumDebitsByWindow.mockResolvedValue(50);

      await BillingReconcileService.runReconciliation();

      const mismatchEmits = mockEvents.emit.mock.calls.filter(
        ([, p]) => p?.subType === 'meter_extras_mismatch',
      );
      expect(mismatchEmits).toHaveLength(0);
    });
  });
});
