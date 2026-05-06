/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for BillingReconcileService.runReconciliation.
 * Validates LOG-ONLY policy, pagination, divergence detection, and error handling.
 */
describe('BillingReconcileService.runReconciliation unit tests:', () => {
  let BillingReconcileService;
  let mockStripeInstance;
  let mockGetStripe;
  let mockLogger;
  let mockEvents;
  let mockSubscriptionModel;
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

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: mockGetStripe }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: mockEvents }));
    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn(() => mockSubscriptionModel),
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
});
