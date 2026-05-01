/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.reset.service.js
 */
describe('BillingResetService unit tests:', () => {
  let BillingResetService;
  let mockUsageRepository;
  let mockPlanService;
  let mockConfig;
  let mockSubscriptionRepository;

  const orgId = '507f1f77bcf86cd799439011';

  /**
   * @param {Object} [overrides={}] - Fields to override on the stub plan.
   * @returns {Object} A stub BillingPlan document.
   */
  const makePlan = (overrides = {}) => ({
    planId: 'pro',
    version: 'v1',
    meterQuota: 500000,
    active: true,
    ...overrides,
  });

  /**
   * @param {Object} [overrides={}] - Fields to override on the stub usage document.
   * @returns {Object} A stub BillingUsage document.
   */
  const makeUsageDoc = (overrides = {}) => ({
    _id: '507f1f77bcf86cd799439099',
    organizationId: orgId,
    weekKey: '2026-W18',
    meterUsed: 0,
    meterQuota: 500000,
    planVersion: 'v1',
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));

    mockConfig = {
      billing: {
        meterMode: true,
        defaultPlan: 'starter',
      },
    };

    mockUsageRepository = {
      findByWeek: jest.fn(),
      increment: jest.fn(),
      get: jest.fn(),
      reset: jest.fn(),
      incrementMeter: jest.fn(),
      archiveOtherWeeks: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      upsertWeekSnapshot: jest.fn(),
    };

    mockPlanService = {
      getActivePlan: jest.fn(),
    };

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      findPlan: jest.fn(),
      findAllDueForReset: jest.fn(),
      findAllDueForResetByLastReset: jest.fn(),
      updateLastResetAt: jest.fn(),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../repositories/billing.usage.repository.js', () => ({
      default: mockUsageRepository,
    }));

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('../services/billing.plan.service.js', () => ({
      default: mockPlanService,
    }));

    const mod = await import('../services/billing.reset.service.js');
    BillingResetService = mod.default;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('isoWeekKey', () => {
    test('should return correct week key for a known Monday', () => {
      // 2026-04-27 is a Monday, ISO week 18
      const result = BillingResetService.isoWeekKey(new Date('2026-04-27'));
      expect(result).toBe('2026-W18');
    });

    test('should return correct week key for a Sunday (same ISO week as preceding Monday)', () => {
      // 2026-05-03 is Sunday, still ISO week 18
      const result = BillingResetService.isoWeekKey(new Date('2026-05-03'));
      expect(result).toBe('2026-W18');
    });

    test('should compute week 1 for first week of year', () => {
      // 2026-01-01 is Thursday — ISO week 1 of 2026
      const result = BillingResetService.isoWeekKey(new Date('2026-01-01'));
      expect(result).toBe('2026-W01');
    });
  });

  describe('resetWeek', () => {
    test('should return null when meterMode is disabled', async () => {
      mockConfig.billing.meterMode = false;
      const result = await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));
      expect(result).toBeNull();
    });

    test('should archive old week docs and upsert new week doc', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      mockUsageRepository.findByWeek.mockResolvedValue(null);
      const newDoc = makeUsageDoc({ weekKey: '2026-W18' });
      mockUsageRepository.upsertWeekSnapshot.mockResolvedValue(newDoc);

      const result = await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      expect(mockUsageRepository.archiveOtherWeeks).toHaveBeenCalledWith(
        orgId,
        '2026-W18',
        expect.any(Date),
      );
      expect(result).toBe(newDoc);
    });

    test('should be idempotent — return existing doc if week already exists', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      const existingDoc = makeUsageDoc({ weekKey: '2026-W18' });
      mockUsageRepository.findByWeek.mockResolvedValue(existingDoc);

      const result = await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      // Should not call upsertWeekSnapshot since doc already exists
      expect(mockUsageRepository.upsertWeekSnapshot).not.toHaveBeenCalled();
      expect(result).toBe(existingDoc);
    });

    test('should snapshot meterQuota and planVersion from active plan', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 1000000, version: 'v3' }));
      mockUsageRepository.findByWeek.mockResolvedValue(null);
      let capturedSnapshot;
      mockUsageRepository.upsertWeekSnapshot.mockImplementation((orgId, weekKey, snapshot) => {
        capturedSnapshot = snapshot;
        return Promise.resolve(makeUsageDoc());
      });

      await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      expect(capturedSnapshot.meterQuota).toBe(1000000);
      expect(capturedSnapshot.planVersion).toBe('v3');
    });

    test('should use subscribed plan as source of truth', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ planId: 'pro' }));
      mockUsageRepository.findByWeek.mockResolvedValue(makeUsageDoc({ weekKey: '2026-W18' }));

      await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      expect(mockSubscriptionRepository.findPlan).toHaveBeenCalledWith(orgId);
      expect(mockPlanService.getActivePlan).toHaveBeenCalledWith('pro');
    });

    test('should use defaultPlan when subscription is missing', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue(null);
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ planId: 'starter' }));
      mockUsageRepository.findByWeek.mockResolvedValue(makeUsageDoc({ weekKey: '2026-W18' }));

      await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      expect(mockPlanService.getActivePlan).toHaveBeenCalledWith('starter');
    });

    test('should fall back to free when subscription and defaultPlan are missing', async () => {
      mockConfig.billing.defaultPlan = undefined;
      mockSubscriptionRepository.findPlan.mockResolvedValue(null);
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ planId: 'free' }));
      mockUsageRepository.findByWeek.mockResolvedValue(makeUsageDoc({ weekKey: '2026-W18' }));

      await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      expect(mockPlanService.getActivePlan).toHaveBeenCalledWith('free');
    });

    test('should use meterQuota=0 when no active plan exists', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(null);
      mockUsageRepository.findByWeek.mockResolvedValue(null);
      let capturedSnapshot;
      mockUsageRepository.upsertWeekSnapshot.mockImplementation((orgId, weekKey, snapshot) => {
        capturedSnapshot = snapshot;
        return Promise.resolve(makeUsageDoc({ meterQuota: 0 }));
      });

      await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      expect(capturedSnapshot.meterQuota).toBe(0);
      expect(capturedSnapshot.planVersion).toBeNull();
    });

    test('should handle E11000 race by falling back to findByWeek', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      mockUsageRepository.findByWeek
        .mockResolvedValueOnce(null) // First call: doc not yet created
        .mockResolvedValueOnce(makeUsageDoc()); // Second call after E11000: doc exists
      const e11000 = new Error('E11000 duplicate key');
      e11000.code = 11000;
      mockUsageRepository.upsertWeekSnapshot.mockRejectedValue(e11000);

      const result = await BillingResetService.resetWeek(orgId, new Date('2026-04-27'));

      expect(result).toBeDefined();
      expect(mockUsageRepository.findByWeek).toHaveBeenCalledTimes(2);
    });
  });

  describe('resetAllDue', () => {
    test('should return processed=0, errors=0 when meterMode is disabled', async () => {
      mockConfig.billing.meterMode = false;
      const result = await BillingResetService.resetAllDue();
      expect(result).toEqual({ processed: 0, errors: 0 });
    });

    test('should call resetWeek for each active subscription', async () => {
      const now = new Date('2026-05-01T12:00:00.000Z');
      const periodStart = new Date('2026-04-29T12:00:00.000Z');

      mockSubscriptionRepository.findAllDueForResetByLastReset.mockResolvedValue([
        { organization: '507f1f77bcf86cd799439011', currentPeriodStart: periodStart },
        { organization: '507f1f77bcf86cd799439022', currentPeriodStart: periodStart },
      ]);
      mockSubscriptionRepository.updateLastResetAt.mockResolvedValue({});

      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      mockUsageRepository.findByWeek.mockResolvedValue(null);
      mockUsageRepository.upsertWeekSnapshot.mockResolvedValue(makeUsageDoc());

      const result = await BillingResetService.resetAllDue();
      expect(result.processed).toBe(2);
      expect(result.errors).toBe(0);
      expect(mockSubscriptionRepository.findAllDueForResetByLastReset).toHaveBeenCalledWith(now);
      expect(mockSubscriptionRepository.updateLastResetAt).toHaveBeenNthCalledWith(
        1,
        '507f1f77bcf86cd799439011',
        now,
      );
      expect(mockSubscriptionRepository.updateLastResetAt).toHaveBeenNthCalledWith(
        2,
        '507f1f77bcf86cd799439022',
        now,
      );
    });

    test('should count errors when resetWeek fails for a subscription', async () => {
      const periodStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      mockSubscriptionRepository.findAllDueForResetByLastReset.mockResolvedValue([
        { organization: '507f1f77bcf86cd799439011', currentPeriodStart: periodStart },
      ]);
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockRejectedValue(new Error('DB error'));
      mockUsageRepository.findByWeek.mockResolvedValue(null);

      const result = await BillingResetService.resetAllDue();
      expect(result.errors).toBe(1);
      expect(result.processed).toBe(0);
      expect(mockSubscriptionRepository.updateLastResetAt).not.toHaveBeenCalled();
    });

    test('should pass undefined orgId when sub uses organizationId (wrong field) — regression guard', async () => {
      // This test ensures the service reads sub.organization, not sub.organizationId.
      // If someone reverts to sub.organizationId, String(undefined) = 'undefined' → resetWeek
      // would receive 'undefined' as orgId, which fails ObjectId validation and skips archive+upsert.
      // We verify that when the correct field `organization` is present, it is forwarded correctly.
      const periodStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const capturedOrgIds = [];
      mockSubscriptionRepository.findAllDueForResetByLastReset.mockResolvedValue([
        { organization: '507f1f77bcf86cd799439011', currentPeriodStart: periodStart },
      ]);
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockSubscriptionRepository.updateLastResetAt.mockResolvedValue({});
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      mockUsageRepository.findByWeek.mockImplementation((orgId) => {
        capturedOrgIds.push(orgId);
        return Promise.resolve(makeUsageDoc({ organizationId: orgId }));
      });

      await BillingResetService.resetAllDue();

      // The orgId forwarded to the repo must be the real ObjectId, not 'undefined'
      expect(capturedOrgIds[0]).toBe('507f1f77bcf86cd799439011');
    });

    test('should update lastResetAt after a successful reset', async () => {
      const now = new Date('2026-05-01T12:00:00.000Z');
      mockSubscriptionRepository.findAllDueForResetByLastReset.mockResolvedValue([
        { organization: orgId, currentPeriodStart: new Date('2026-04-27T00:00:00.000Z') },
      ]);
      mockSubscriptionRepository.updateLastResetAt.mockResolvedValue({});
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      mockUsageRepository.findByWeek.mockResolvedValue(null);
      mockUsageRepository.upsertWeekSnapshot.mockResolvedValue(makeUsageDoc());

      const result = await BillingResetService.resetAllDue();

      expect(result).toEqual({ processed: 1, errors: 0 });
      expect(mockSubscriptionRepository.updateLastResetAt).toHaveBeenCalledWith(orgId, now);
    });
  });
});
