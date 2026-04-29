/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.plan.service.js
 */
describe('BillingPlanService unit tests:', () => {
  let BillingPlanService;
  let mockBillingPlanRepository;

  /**
   * Build a BillingPlan-like document for tests.
   * @param {Object} [overrides={}] - Field overrides.
   * @returns {Object} Mock BillingPlan document.
   */
  const makeDoc = (overrides = {}) => ({
    _id: '507f1f77bcf86cd799439011',
    planId: 'pro',
    version: 'v1',
    meterQuota: 500000,
    ratios: { scrap: 1, autofix: 2 },
    effectiveFrom: new Date('2026-05-01'),
    effectiveUntil: null,
    active: true,
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockBillingPlanRepository = {
      findActive: jest.fn(),
      findByVersion: jest.fn(),
      deactivateAll: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    };

    jest.unstable_mockModule('../repositories/billing.plan.repository.js', () => ({
      default: mockBillingPlanRepository,
    }));

    const mod = await import('../services/billing.plan.service.js');
    BillingPlanService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getActivePlan', () => {
    test('should return the active plan from DB', async () => {
      const plan = makeDoc();
      mockBillingPlanRepository.findActive.mockResolvedValue(plan);

      const result = await BillingPlanService.getActivePlan('pro');

      expect(mockBillingPlanRepository.findActive).toHaveBeenCalledWith('pro');
      expect(result.planId).toBe('pro');
      expect(result.version).toBe('v1');
    });

    test('should return null when no active plan exists', async () => {
      mockBillingPlanRepository.findActive.mockResolvedValue(null);

      const result = await BillingPlanService.getActivePlan('unknown');
      expect(result).toBeNull();
    });

    test('should cache the result and avoid a second DB call', async () => {
      const plan = makeDoc();
      mockBillingPlanRepository.findActive.mockResolvedValue(plan);

      await BillingPlanService.getActivePlan('pro');
      await BillingPlanService.getActivePlan('pro');

      expect(mockBillingPlanRepository.findActive).toHaveBeenCalledTimes(1);
    });

    test('should re-fetch after cache invalidation', async () => {
      const plan = makeDoc();
      mockBillingPlanRepository.findActive.mockResolvedValue(plan);

      await BillingPlanService.getActivePlan('pro');
      BillingPlanService.invalidateCache('pro');
      await BillingPlanService.getActivePlan('pro');

      expect(mockBillingPlanRepository.findActive).toHaveBeenCalledTimes(2);
    });

    test('should NOT cache null results (plan not found)', async () => {
      mockBillingPlanRepository.findActive.mockResolvedValue(null);

      await BillingPlanService.getActivePlan('starter');
      await BillingPlanService.getActivePlan('starter');

      // null is not cached — both calls hit the repository
      expect(mockBillingPlanRepository.findActive).toHaveBeenCalledTimes(2);
    });

    test('should propagate findActive lean() result without modification', async () => {
      const leanDoc = makeDoc({ extra: 'lean-field' });
      mockBillingPlanRepository.findActive.mockResolvedValue(leanDoc);

      const result = await BillingPlanService.getActivePlan('pro');

      // The service must not alter the repo result — pass-through contract
      expect(result).toBe(leanDoc);
      expect(result.extra).toBe('lean-field');
    });
  });

  describe('getPlanByVersion', () => {
    test('should return a plan by (planId, version)', async () => {
      const plan = makeDoc({ version: 'v2' });
      mockBillingPlanRepository.findByVersion.mockResolvedValue(plan);

      const result = await BillingPlanService.getPlanByVersion('pro', 'v2');

      expect(mockBillingPlanRepository.findByVersion).toHaveBeenCalledWith('pro', 'v2');
      expect(result.version).toBe('v2');
    });

    test('should return null for unknown version', async () => {
      mockBillingPlanRepository.findByVersion.mockResolvedValue(null);

      const result = await BillingPlanService.getPlanByVersion('pro', 'v99');
      expect(result).toBeNull();
    });
  });

  describe('bumpVersion', () => {
    test('should deactivate existing active versions', async () => {
      const newPlan = makeDoc({ version: 'v2', active: true });
      mockBillingPlanRepository.deactivateAll.mockResolvedValue({ modifiedCount: 1 });
      mockBillingPlanRepository.count.mockResolvedValue(1);
      mockBillingPlanRepository.create.mockResolvedValue([newPlan]);

      await BillingPlanService.bumpVersion('pro', { meterQuota: 1000000 });

      expect(mockBillingPlanRepository.deactivateAll).toHaveBeenCalledWith(
        'pro',
        expect.any(Date),
      );
    });

    test('should create new version with incremented version number', async () => {
      const newPlan = makeDoc({ version: 'v2' });
      mockBillingPlanRepository.deactivateAll.mockResolvedValue({});
      mockBillingPlanRepository.count.mockResolvedValue(1); // 1 existing → next is v2
      mockBillingPlanRepository.create.mockResolvedValue([newPlan]);

      await BillingPlanService.bumpVersion('pro', { meterQuota: 1000000 });

      expect(mockBillingPlanRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ planId: 'pro', version: 'v2', meterQuota: 1000000, active: true }),
      );
    });

    test('should invalidate cache after bump', async () => {
      const plan = makeDoc();
      mockBillingPlanRepository.findActive.mockResolvedValue(plan);
      mockBillingPlanRepository.deactivateAll.mockResolvedValue({});
      mockBillingPlanRepository.count.mockResolvedValue(1);
      mockBillingPlanRepository.create.mockResolvedValue([makeDoc({ version: 'v2' })]);

      // Populate cache first
      await BillingPlanService.getActivePlan('pro');
      expect(mockBillingPlanRepository.findActive).toHaveBeenCalledTimes(1);

      // Bump should evict cache
      await BillingPlanService.bumpVersion('pro', { meterQuota: 999 });

      // Next getActivePlan should hit repository again
      await BillingPlanService.getActivePlan('pro');
      expect(mockBillingPlanRepository.findActive).toHaveBeenCalledTimes(2);
    });

    test('should use ratios from fields when provided', async () => {
      const newPlan = makeDoc({ version: 'v2', ratios: { scrap: 3 } });
      mockBillingPlanRepository.deactivateAll.mockResolvedValue({});
      mockBillingPlanRepository.count.mockResolvedValue(1);
      mockBillingPlanRepository.create.mockResolvedValue([newPlan]);

      await BillingPlanService.bumpVersion('pro', { meterQuota: 500000, ratios: { scrap: 3 } });

      expect(mockBillingPlanRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ ratios: { scrap: 3 } }),
      );
    });

    test('should default ratios to empty object when not provided', async () => {
      mockBillingPlanRepository.deactivateAll.mockResolvedValue({});
      mockBillingPlanRepository.count.mockResolvedValue(0);
      mockBillingPlanRepository.create.mockResolvedValue([makeDoc({ version: 'v1', ratios: {} })]);

      await BillingPlanService.bumpVersion('starter', { meterQuota: 100000 });

      expect(mockBillingPlanRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ ratios: {} }),
      );
    });

    test('should propagate DB errors', async () => {
      mockBillingPlanRepository.deactivateAll.mockRejectedValue(new Error('DB write error'));

      await expect(BillingPlanService.bumpVersion('pro', { meterQuota: 1 })).rejects.toThrow('DB write error');
    });
  });

  describe('invalidateCache', () => {
    test('should remove planId from cache so next call fetches from repository', async () => {
      const plan = makeDoc();
      mockBillingPlanRepository.findActive.mockResolvedValue(plan);

      await BillingPlanService.getActivePlan('pro');
      BillingPlanService.invalidateCache('pro');
      await BillingPlanService.getActivePlan('pro');

      expect(mockBillingPlanRepository.findActive).toHaveBeenCalledTimes(2);
    });

    test('should be a no-op for unknown planId', () => {
      expect(() => BillingPlanService.invalidateCache('never-cached')).not.toThrow();
    });
  });
});
