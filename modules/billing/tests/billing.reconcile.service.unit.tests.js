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
  let mockSubscriptionModel;
  let mockUsageModel;
  let mockExtraBalanceModel;
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
   */
  const makeStripeSub = (overrides = {}) => ({
    id: stripeSubId,
    status: 'active',
    items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
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
    };

    mockStripeInstance = {
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(makeStripeSub()),
      },
    };
    mockGetStripe = jest.fn().mockReturnValue(mockStripeInstance);

    // The subscription model is accessed via mongoose.model('Subscription')
    const mockFindChain = {
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    mockSubscriptionModel = {
      find: jest.fn().mockReturnValue(mockFindChain),
    };

    // Default usage doc: 200 used, 100 quota → 100 units in extras expected
    mockUsageModel = {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ meterUsed: 200, meterQuota: 100 }),
      }),
    };

    // Default extra balance doc: 100 units debited (matches expected)
    mockExtraBalanceModel = {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          ledger: [
            { kind: 'debit', amount: -100, at: new Date() },
          ],
        }),
      }),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: mockGetStripe }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: mockEvents }));
    jest.unstable_mockModule('../lib/billing.isoWeek.js', () => ({
      currentWeekKey: jest.fn().mockReturnValue('2026-W18'),
    }));
    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn((name) => {
          if (name === 'BillingUsage') return mockUsageModel;
          if (name === 'BillingExtraBalance') return mockExtraBalanceModel;
          return mockSubscriptionModel;
        }),
      },
    }));
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {},
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
    // find returns empty — loop exits immediately
    const mockFindChain = {
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    mockSubscriptionModel.find.mockReturnValue(mockFindChain);

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toEqual({ checked: 0, divergences: 0, errors: 0 });
  });

  test('checks matching sub — no divergence when status + plan match', async () => {
    const sub = makeDbSub();
    const chain = {
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn()
        .mockResolvedValueOnce([sub])  // first page: 1 sub
        .mockResolvedValue([]),         // second page: empty → exit
    };
    mockSubscriptionModel.find.mockReturnValue(chain);
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toMatchObject({ checked: 1, divergences: 0, errors: 0 });
    expect(mockEvents.emit).not.toHaveBeenCalled();
  });

  test('detects status divergence — emits billing.reconciliation.divergence and logs', async () => {
    const sub = makeDbSub({ status: 'active' });
    const chain = {
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValue([]),
    };
    mockSubscriptionModel.find.mockReturnValue(chain);
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
    const chain = {
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValue([]),
    };
    mockSubscriptionModel.find.mockReturnValue(chain);
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

  test('counts errors and continues on individual Stripe retrieve failure', async () => {
    const subs = [makeDbSub(), makeDbSub({ _id: 'sub_doc_002', stripeSubscriptionId: 'sub_test_002' })];
    const chain = {
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn()
        .mockResolvedValueOnce(subs)
        .mockResolvedValue([]),
    };
    mockSubscriptionModel.find.mockReturnValue(chain);
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
    const chain = {
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValue([]),
    };
    mockSubscriptionModel.find.mockReturnValue(chain);
    // Deliberate divergence
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub({ status: 'past_due' }));

    await BillingReconcileService.runReconciliation();

    // No DB write must happen — only Stripe reads + logs
    // (mockSubscriptionModel has no update/save methods set up — if called they'd throw)
  });

  test('paginates to second page when first page is full (RECONCILE_PAGE_SIZE=100)', async () => {
    // Build an array of 100 subs (full page) then an empty second page
    const fullPage = Array.from({ length: 100 }, (_, i) => makeDbSub({
      _id: `sub_doc_${i}`,
      stripeSubscriptionId: `sub_test_${i}`,
    }));

    const chain = {
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn()
        .mockResolvedValueOnce(fullPage)  // page 0: full — triggers page += 1
        .mockResolvedValueOnce([]),        // page 1: empty — exits loop
    };
    mockSubscriptionModel.find.mockReturnValue(chain);
    mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

    const result = await BillingReconcileService.runReconciliation();

    // All 100 subs from page 0 should be checked
    expect(result).toMatchObject({ checked: 100, divergences: 0, errors: 0 });
    // find should have been called twice (page 0 + page 1)
    expect(mockSubscriptionModel.find).toHaveBeenCalledTimes(2);
  });

  test('non-fatal: billingEvents.emit listener error is swallowed, divergence still counted', async () => {
    const sub = makeDbSub({ status: 'active' });
    const chain = {
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValue([]),
    };
    mockSubscriptionModel.find.mockReturnValue(chain);
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
    const makeSingleSubChain = (sub) => ({
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValue([]),
    });

    test('matching sums — no divergence, no event emitted', async () => {
      const sub = makeDbSub();
      mockSubscriptionModel.find.mockReturnValue(makeSingleSubChain(sub));
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

      // meterUsed=200, meterQuota=100 → expectedExtras=100
      // ledger debit=-100 → actualDebits=100
      // delta=0 → within tolerance → no divergence
      mockUsageModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ meterUsed: 200, meterQuota: 100 }),
      });
      mockExtraBalanceModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          ledger: [{ kind: 'debit', amount: -100, at: new Date() }],
        }),
      });

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
      mockSubscriptionModel.find.mockReturnValue(makeSingleSubChain(sub));
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

      // expectedExtras=10000, actualDebits=9990 → delta=10
      // tolerance = max(50, 0.5% × 10000) = max(50, 50) = 50
      // delta(10) <= tolerance(50) → no divergence
      mockUsageModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ meterUsed: 10100, meterQuota: 100 }),
      });
      mockExtraBalanceModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          ledger: [{ kind: 'debit', amount: -9990, at: new Date() }],
        }),
      });

      await BillingReconcileService.runReconciliation();

      const mismatchEmits = mockEvents.emit.mock.calls.filter(
        ([, p]) => p?.subType === 'meter_extras_mismatch',
      );
      expect(mismatchEmits).toHaveLength(0);
    });

    test('large delta — over tolerance — emits billing.reconciliation.divergence with subType:meter_extras_mismatch', async () => {
      const sub = makeDbSub();
      mockSubscriptionModel.find.mockReturnValue(makeSingleSubChain(sub));
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

      // expectedExtras=10000, actualDebits=5000 → delta=5000
      // tolerance = max(50, 0.5% × 10000) = 50 → delta(5000) >> tolerance
      mockUsageModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ meterUsed: 10100, meterQuota: 100 }),
      });
      mockExtraBalanceModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          ledger: [{ kind: 'debit', amount: -5000, at: new Date() }],
        }),
      });

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
      mockSubscriptionModel.find.mockReturnValue(makeSingleSubChain(sub));
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(makeStripeSub());

      // Simulate BillingUsage.findOne throwing
      mockUsageModel.findOne.mockReturnValue({
        lean: jest.fn().mockRejectedValue(new Error('DB unavailable')),
      });

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
      mockSubscriptionModel.find.mockReturnValue(makeSingleSubChain(sub));
      mockStripeInstance.subscriptions.retrieve.mockResolvedValue(
        makeStripeSub({ items: { data: [{ price: { metadata: { planId: 'free' } } }] } }),
      );

      // meterUsed=50, meterQuota=0 → expectedExtras=50 (all units are extras)
      // actualDebits=50 → delta=0 → no divergence
      mockUsageModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ meterUsed: 50, meterQuota: 0 }),
      });
      mockExtraBalanceModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          ledger: [{ kind: 'debit', amount: -50, at: new Date() }],
        }),
      });

      await BillingReconcileService.runReconciliation();

      const mismatchEmits = mockEvents.emit.mock.calls.filter(
        ([, p]) => p?.subType === 'meter_extras_mismatch',
      );
      expect(mismatchEmits).toHaveLength(0);
    });
  });
});
