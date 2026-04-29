/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.plan.service.js
 */
describe('BillingPlanService unit tests:', () => {
  let BillingPlanService;
  let mockBillingPlan;

  /**
   * Build a BillingPlan-like document for tests.
   * @param {Object} [overrides={}] - Field overrides.
   * @returns {Object} Mock BillingPlan document.
   */
  const makeDoc = (overrides = {}) => ({
    _id: '507f1f77bcf86cd799439011',
    planId: 'pro',
    version: 'v1',
    computeQuota: 500000,
    ratios: { scrap: 1, autofix: 2 },
    effectiveFrom: new Date('2026-05-01'),
    effectiveUntil: null,
    active: true,
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockBillingPlan = {
      findOne: jest.fn(),
      updateMany: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn().mockReturnValue(mockBillingPlan),
      },
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
      mockBillingPlan.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(plan) });

      const result = await BillingPlanService.getActivePlan('pro');

      expect(mockBillingPlan.findOne).toHaveBeenCalledWith(
        { planId: 'pro', active: true, effectiveUntil: null },
      );
      expect(result.planId).toBe('pro');
      expect(result.version).toBe('v1');
    });

    test('should return null when no active plan exists', async () => {
      mockBillingPlan.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

      const result = await BillingPlanService.getActivePlan('unknown');
      expect(result).toBeNull();
    });

    test('should cache the result and avoid a second DB call', async () => {
      const plan = makeDoc();
      mockBillingPlan.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(plan) });

      await BillingPlanService.getActivePlan('pro');
      await BillingPlanService.getActivePlan('pro');

      expect(mockBillingPlan.findOne).toHaveBeenCalledTimes(1);
    });

    test('should re-fetch after cache invalidation', async () => {
      const plan = makeDoc();
      mockBillingPlan.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(plan) });

      await BillingPlanService.getActivePlan('pro');
      BillingPlanService.invalidateCache('pro');
      await BillingPlanService.getActivePlan('pro');

      expect(mockBillingPlan.findOne).toHaveBeenCalledTimes(2);
    });

    test('should NOT cache null results (plan not found)', async () => {
      mockBillingPlan.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

      await BillingPlanService.getActivePlan('starter');
      await BillingPlanService.getActivePlan('starter');

      // null is not cached — both calls hit the DB
      expect(mockBillingPlan.findOne).toHaveBeenCalledTimes(2);
    });
  });

  describe('getPlanByVersion', () => {
    test('should return a plan by (planId, version)', async () => {
      const plan = makeDoc({ version: 'v2' });
      mockBillingPlan.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(plan) });

      const result = await BillingPlanService.getPlanByVersion('pro', 'v2');

      expect(mockBillingPlan.findOne).toHaveBeenCalledWith({ planId: 'pro', version: 'v2' });
      expect(result.version).toBe('v2');
    });

    test('should return null for unknown version', async () => {
      mockBillingPlan.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

      const result = await BillingPlanService.getPlanByVersion('pro', 'v99');
      expect(result).toBeNull();
    });
  });

  describe('bumpVersion', () => {
    test('should deactivate existing active versions', async () => {
      const newPlan = makeDoc({ version: 'v2', active: true });
      mockBillingPlan.updateMany.mockResolvedValue({ modifiedCount: 1 });
      mockBillingPlan.countDocuments.mockResolvedValue(1);
      mockBillingPlan.create.mockResolvedValue([newPlan]);

      await BillingPlanService.bumpVersion('pro', { computeQuota: 1000000 });

      expect(mockBillingPlan.updateMany).toHaveBeenCalledWith(
        { planId: 'pro', active: true },
        { $set: { active: false, effectiveUntil: expect.any(Date) } },
      );
    });

    test('should create new version with incremented version number', async () => {
      const newPlan = makeDoc({ version: 'v2' });
      mockBillingPlan.updateMany.mockResolvedValue({});
      mockBillingPlan.countDocuments.mockResolvedValue(1); // 1 existing → next is v2
      mockBillingPlan.create.mockResolvedValue([newPlan]);

      await BillingPlanService.bumpVersion('pro', { computeQuota: 1000000 });

      expect(mockBillingPlan.create).toHaveBeenCalledWith(
        expect.objectContaining({ planId: 'pro', version: 'v2', computeQuota: 1000000, active: true }),
      );
    });

    test('should invalidate cache after bump', async () => {
      const plan = makeDoc();
      mockBillingPlan.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(plan) });
      mockBillingPlan.updateMany.mockResolvedValue({});
      mockBillingPlan.countDocuments.mockResolvedValue(1);
      mockBillingPlan.create.mockResolvedValue([makeDoc({ version: 'v2' })]);

      // Populate cache first
      await BillingPlanService.getActivePlan('pro');
      expect(mockBillingPlan.findOne).toHaveBeenCalledTimes(1);

      // Bump should evict cache
      await BillingPlanService.bumpVersion('pro', { computeQuota: 999 });

      // Next getActivePlan should hit DB again
      await BillingPlanService.getActivePlan('pro');
      expect(mockBillingPlan.findOne).toHaveBeenCalledTimes(2);
    });

    test('should use ratios from fields when provided', async () => {
      const newPlan = makeDoc({ version: 'v2', ratios: { scrap: 3 } });
      mockBillingPlan.updateMany.mockResolvedValue({});
      mockBillingPlan.countDocuments.mockResolvedValue(1);
      mockBillingPlan.create.mockResolvedValue([newPlan]);

      await BillingPlanService.bumpVersion('pro', { computeQuota: 500000, ratios: { scrap: 3 } });

      expect(mockBillingPlan.create).toHaveBeenCalledWith(
        expect.objectContaining({ ratios: { scrap: 3 } }),
      );
    });

    test('should default ratios to empty object when not provided', async () => {
      mockBillingPlan.updateMany.mockResolvedValue({});
      mockBillingPlan.countDocuments.mockResolvedValue(0);
      mockBillingPlan.create.mockResolvedValue([makeDoc({ version: 'v1', ratios: {} })]);

      await BillingPlanService.bumpVersion('starter', { computeQuota: 100000 });

      expect(mockBillingPlan.create).toHaveBeenCalledWith(
        expect.objectContaining({ ratios: {} }),
      );
    });

    test('should propagate DB errors', async () => {
      mockBillingPlan.updateMany.mockRejectedValue(new Error('DB write error'));

      await expect(BillingPlanService.bumpVersion('pro', { computeQuota: 1 })).rejects.toThrow('DB write error');
    });
  });

  describe('invalidateCache', () => {
    test('should remove planId from cache so next call fetches from DB', async () => {
      const plan = makeDoc();
      mockBillingPlan.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(plan) });

      await BillingPlanService.getActivePlan('pro');
      BillingPlanService.invalidateCache('pro');
      await BillingPlanService.getActivePlan('pro');

      expect(mockBillingPlan.findOne).toHaveBeenCalledTimes(2);
    });

    test('should be a no-op for unknown planId', () => {
      expect(() => BillingPlanService.invalidateCache('never-cached')).not.toThrow();
    });
  });
});
