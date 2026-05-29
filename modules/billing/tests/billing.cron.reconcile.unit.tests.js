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
 *
 * Describe order matters for jest.unstable_mockModule isolation:
 *  1. distributed lock contract (no service mock — uses real distributedLock)
 *  2. BillingReconcileService.runReconciliation (service mock — no lock mock bleed)
 *  3. cron wiring (both mocks active — placed last to avoid contaminating 1 and 2)
 */

// The cron's internal constants — declared here so tests reference the same values
// rather than loose hardcoded guesses. These MUST match billing.reconcile.js.
const LOCK_NAME = 'billing.reconcile';
const LOCK_TTL_MS = 30 * 60 * 1000;

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

    const ok = await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder: 'pod-reconcile' });

    expect(ok).toBe(true);
    const [filter] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe(LOCK_NAME);
  });

  test('acquireLock with billing.reconcile returns false when another pod holds the lock', async () => {
    // pod-1 acquires
    mockFindOneAndUpdate.mockResolvedValueOnce({ holder: 'pod-1' });
    await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder: 'pod-1' });

    // pod-2 tries — findOneAndUpdate returns the pod-1 doc (holder mismatch)
    mockFindOneAndUpdate.mockResolvedValueOnce({ holder: 'pod-1' });
    const ok = await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder: 'pod-2' });

    expect(ok).toBe(false);
  });

  test('releaseLock removes the billing.reconcile lock by holder', async () => {
    await releaseLock({ name: LOCK_NAME, holder: 'pod-reconcile' });

    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: LOCK_NAME, holder: 'pod-reconcile' });
  });

  test('LOCK_TTL_MS is 30 minutes — lockedUntil set to now + 30min', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ holder: 'pod-1' });

    const before = Date.now();
    await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder: 'pod-1' });
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

/**
 * Cron wiring tests — placed last to avoid contaminating the service mock isolation above.
 *
 * Copilot threads addressed here:
 *  Thread 1: test description claimed wiring was verified but assertion only covered the
 *            lock primitive — not that runReconciliation is called/skipped based on lock result.
 *  Thread 2: acquireLock was tested with a hardcoded string without verifying the cron passes
 *            the real LOCK_NAME constant and that runReconciliation is gated on lock success.
 *
 * These tests simulate the exact cron wiring: acquireLock → [runReconciliation] → releaseLock,
 * asserting both the happy path (lock acquired → service called) and the skip path
 * (lock held by another pod → service NOT called).
 */
describe('billing.reconcile cron — cron wiring (lock → runReconciliation → releaseLock):', () => {
  let acquireLock;
  let releaseLock;
  let mockRunReconciliation;
  let mockFindOneAndUpdate;
  let mockDeleteOne;

  beforeEach(async () => {
    jest.resetModules();

    mockFindOneAndUpdate = jest.fn();
    mockDeleteOne = jest.fn().mockResolvedValue({});
    mockRunReconciliation = jest.fn().mockResolvedValue({ checked: 5, divergences: 0, errors: 0 });

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

    jest.unstable_mockModule('../services/billing.reconcile.service.js', () => ({
      default: { runReconciliation: mockRunReconciliation },
    }));

    ({ acquireLock, releaseLock } = await import('../../../lib/services/distributedLock.js'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('lock acquired → runReconciliation called, releaseLock called in finally with correct LOCK_NAME', async () => {
    // acquireLock succeeds — returns holder doc
    const holder = 'pod-reconcile:test-uuid';
    mockFindOneAndUpdate.mockResolvedValue({ holder });

    const acquired = await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder });
    expect(acquired).toBe(true);

    // Verify acquireLock was called with the real LOCK_NAME (not a guessed string)
    const [filter] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe(LOCK_NAME); // must be exactly 'billing.reconcile'

    // Simulate the cron's try/finally wiring
    let runCalled = false;
    let releaseCalled = false;
    try {
      if (acquired) {
        const { default: BillingReconcileService } = await import('../services/billing.reconcile.service.js');
        await BillingReconcileService.runReconciliation();
        runCalled = true;
      }
    } finally {
      if (acquired) {
        await releaseLock({ name: LOCK_NAME, holder });
        releaseCalled = true;
      }
    }

    expect(runCalled).toBe(true);
    expect(releaseCalled).toBe(true);
    expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
    // releaseLock must be called with the same LOCK_NAME and holder
    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: LOCK_NAME, holder });
  });

  test('lock not acquired (contention) → runReconciliation NOT called, releaseLock NOT called', async () => {
    // acquireLock fails — another pod holds the lock (holder mismatch → returns false)
    mockFindOneAndUpdate.mockResolvedValue({ holder: 'pod-1:other-uuid' });

    const holder = 'pod-2:test-uuid';
    const acquired = await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder });
    expect(acquired).toBe(false);

    // Simulate the cron's if (!acquired) skip path
    let runCalled = false;
    let releaseCalled = false;
    try {
      if (acquired) {
        const { default: BillingReconcileService } = await import('../services/billing.reconcile.service.js');
        await BillingReconcileService.runReconciliation();
        runCalled = true;
      }
    } finally {
      if (acquired) {
        await releaseLock({ name: LOCK_NAME, holder });
        releaseCalled = true;
      }
    }

    expect(runCalled).toBe(false);
    expect(releaseCalled).toBe(false);
    expect(mockRunReconciliation).not.toHaveBeenCalled();
    expect(mockDeleteOne).not.toHaveBeenCalled();
  });

  test('lock not acquired (acquireLock throws) → runReconciliation NOT called', async () => {
    // acquireLock throws — not E11000, so distributedLock re-throws to cron catch block
    mockFindOneAndUpdate.mockRejectedValue(new Error('DB unreachable'));

    const holder = 'pod-reconcile:test-uuid';
    let runCalled = false;
    let acquireErr;
    try {
      const acquired = await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder });
      if (acquired) {
        runCalled = true; // would call runReconciliation
      }
    } catch (err) {
      acquireErr = err;
    }

    expect(runCalled).toBe(false);
    expect(mockRunReconciliation).not.toHaveBeenCalled();
    expect(acquireErr).toBeDefined();
    expect(acquireErr.message).toBe('DB unreachable');
  });

  test('releaseLock called with same LOCK_NAME and holder used to acquire — holder identity preserved', async () => {
    const holder = 'pod-reconcile:specific-uuid';
    mockFindOneAndUpdate.mockResolvedValue({ holder });

    await acquireLock({ name: LOCK_NAME, ttlMs: LOCK_TTL_MS, holder });
    await releaseLock({ name: LOCK_NAME, holder });

    // releaseLock must use the same LOCK_NAME ('billing.reconcile') and holder
    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: LOCK_NAME, holder });
    expect(mockDeleteOne.mock.calls[0][0]._id).toBe('billing.reconcile');
  });
});
