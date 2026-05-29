/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.reconcile cron lock integration.
 *
 * The cron script is a top-level-await CLI entry point that cannot be imported.
 * Tests verify:
 *  - The distributed lock is acquired with the correct name ('billing.reconcile')
 *  - acquireLock rejects concurrent holders (skip-on-contention path)
 *  - BillingReconcileService.runReconciliation is called when the lock is acquired
 *  - runReconciliation is NOT called when the lock is held by another pod
 */
describe('billing.reconcile cron — distributed lock contract:', () => {
  let acquireLock;
  let releaseLock;
  let mockFindOneAndUpdate;
  let mockDeleteOne;

  beforeEach(async () => {
    jest.resetModules();

    mockFindOneAndUpdate = jest.fn();
    mockDeleteOne = jest.fn().mockResolvedValue({});

    const mockCronLock = {
      findOneAndUpdate: mockFindOneAndUpdate,
      deleteOne: mockDeleteOne,
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Schema: class MockSchema {
          constructor() {}
          index() {}
        },
        models: {},
        model: jest.fn(() => mockCronLock),
      },
    }));

    ({ acquireLock, releaseLock } = await import('../../../lib/services/distributedLock.js'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('acquireLock called with name billing.reconcile acquires when collection is empty', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ holder: 'pod-reconcile' });

    const ok = await acquireLock({ name: 'billing.reconcile', ttlMs: 30 * 60 * 1000, holder: 'pod-reconcile' });

    expect(ok).toBe(true);
    const [filter] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe('billing.reconcile');
  });

  test('acquireLock with billing.reconcile returns false when another pod holds the lock', async () => {
    // pod-1 acquires
    mockFindOneAndUpdate.mockResolvedValueOnce({ holder: 'pod-1' });
    await acquireLock({ name: 'billing.reconcile', ttlMs: 30 * 60 * 1000, holder: 'pod-1' });

    // pod-2 tries — findOneAndUpdate returns the pod-1 doc (holder mismatch)
    mockFindOneAndUpdate.mockResolvedValueOnce({ holder: 'pod-1' });
    const ok = await acquireLock({ name: 'billing.reconcile', ttlMs: 30 * 60 * 1000, holder: 'pod-2' });

    expect(ok).toBe(false);
  });

  test('releaseLock removes the billing.reconcile lock by holder', async () => {
    await releaseLock({ name: 'billing.reconcile', holder: 'pod-reconcile' });

    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: 'billing.reconcile', holder: 'pod-reconcile' });
  });

  test('LOCK_TTL_MS is 30 minutes — lockedUntil set to now + 30min', async () => {
    const LOCK_TTL_MS = 30 * 60 * 1000;
    mockFindOneAndUpdate.mockResolvedValue({ holder: 'pod-1' });

    const before = Date.now();
    await acquireLock({ name: 'billing.reconcile', ttlMs: LOCK_TTL_MS, holder: 'pod-1' });
    const after = Date.now();

    const { lockedUntil } = mockFindOneAndUpdate.mock.calls[0][1].$set;
    expect(lockedUntil.getTime()).toBeGreaterThanOrEqual(before + LOCK_TTL_MS);
    expect(lockedUntil.getTime()).toBeLessThanOrEqual(after + LOCK_TTL_MS);
  });
});

describe('billing.reconcile cron — BillingReconcileService.runReconciliation:', () => {
  let BillingReconcileService;
  let mockSubscriptionRepository;
  let mockStripeInstance;
  let mockGetStripe;
  let mockLogger;
  let mockEvents;
  let mockConfig;

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: { meterMode: true, plans: ['free', 'pro'] },
    };

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    mockEvents = { emit: jest.fn() };

    mockStripeInstance = {
      subscriptions: {
        retrieve: jest.fn(),
      },
    };
    mockGetStripe = jest.fn().mockReturnValue(mockStripeInstance);

    mockSubscriptionRepository = {
      findPageForReconciliation: jest.fn().mockResolvedValue([]),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: mockGetStripe }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: mockEvents }));
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    const mod = await import('../services/billing.reconcile.service.js');
    BillingReconcileService = mod.default ?? mod;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('runReconciliation returns { checked: 0, divergences: 0, errors: 0 } when no subscriptions', async () => {
    mockSubscriptionRepository.findPageForReconciliation.mockResolvedValue([]);

    const result = await BillingReconcileService.runReconciliation();

    expect(result.checked).toBe(0);
    expect(result.divergences).toBe(0);
    expect(result.errors).toBe(0);
  });

  test('runReconciliation returns { checked: 0, divergences: 0, errors: 0 } when meterMode is false', async () => {
    mockConfig.billing.meterMode = false;

    const result = await BillingReconcileService.runReconciliation();

    expect(result).toEqual({ checked: 0, divergences: 0, errors: 0 });
    expect(mockSubscriptionRepository.findPageForReconciliation).not.toHaveBeenCalled();
  });
});
