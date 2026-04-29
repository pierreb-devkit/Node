/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.plan.repository.js
 */
describe('BillingPlanRepository unit tests:', () => {
  let BillingPlanRepository;
  let mockModel;

  beforeEach(async () => {
    jest.resetModules();

    mockModel = {
      findOne: jest.fn(),
      updateMany: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    };

    // findOne().lean() chain
    const leanMock = jest.fn();
    mockModel.findOne.mockReturnValue({ lean: leanMock });

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn(() => mockModel),
      },
    }));

    const mod = await import('../repositories/billing.plan.repository.js');
    BillingPlanRepository = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('findActive', () => {
    test('should call findOne with correct filter and lean()', async () => {
      const plan = { planId: 'pro', version: 'v1', active: true, effectiveUntil: null };
      const leanMock = jest.fn().mockResolvedValue(plan);
      mockModel.findOne.mockReturnValue({ lean: leanMock });

      const result = await BillingPlanRepository.findActive('pro');

      expect(mockModel.findOne).toHaveBeenCalledWith({ planId: 'pro', active: true, effectiveUntil: null });
      expect(leanMock).toHaveBeenCalled();
      expect(result).toBe(plan);
    });

    test('should return null when no active plan exists', async () => {
      const leanMock = jest.fn().mockResolvedValue(null);
      mockModel.findOne.mockReturnValue({ lean: leanMock });

      const result = await BillingPlanRepository.findActive('starter');
      expect(result).toBeNull();
    });
  });

  describe('findByVersion', () => {
    test('should call findOne with planId and version filter and lean()', async () => {
      const plan = { planId: 'pro', version: 'v2' };
      const leanMock = jest.fn().mockResolvedValue(plan);
      mockModel.findOne.mockReturnValue({ lean: leanMock });

      const result = await BillingPlanRepository.findByVersion('pro', 'v2');

      expect(mockModel.findOne).toHaveBeenCalledWith({ planId: 'pro', version: 'v2' });
      expect(leanMock).toHaveBeenCalled();
      expect(result.version).toBe('v2');
    });

    test('should return null for unknown version', async () => {
      const leanMock = jest.fn().mockResolvedValue(null);
      mockModel.findOne.mockReturnValue({ lean: leanMock });

      const result = await BillingPlanRepository.findByVersion('pro', 'v99');
      expect(result).toBeNull();
    });
  });

  describe('deactivateAll', () => {
    test('should call updateMany to mark active plans inactive', async () => {
      const now = new Date();
      mockModel.updateMany.mockResolvedValue({ modifiedCount: 1 });

      const result = await BillingPlanRepository.deactivateAll('pro', now);

      expect(mockModel.updateMany).toHaveBeenCalledWith(
        { planId: 'pro', active: true },
        { $set: { active: false, effectiveUntil: now } },
      );
      expect(result.modifiedCount).toBe(1);
    });

    test('should be a no-op (0 modified) when no active plans exist', async () => {
      const now = new Date();
      mockModel.updateMany.mockResolvedValue({ modifiedCount: 0 });

      const result = await BillingPlanRepository.deactivateAll('starter', now);
      expect(result.modifiedCount).toBe(0);
    });
  });

  describe('count', () => {
    test('should return total plan count for a planId', async () => {
      mockModel.countDocuments.mockResolvedValue(3);

      const result = await BillingPlanRepository.count('pro');

      expect(mockModel.countDocuments).toHaveBeenCalledWith({ planId: 'pro' });
      expect(result).toBe(3);
    });

    test('should return 0 for an unknown planId', async () => {
      mockModel.countDocuments.mockResolvedValue(0);

      const result = await BillingPlanRepository.count('unknown');
      expect(result).toBe(0);
    });
  });

  describe('create', () => {
    test('should call Model.create with the doc and return the result', async () => {
      const doc = { planId: 'pro', version: 'v1', meterQuota: 500000, active: true };
      const created = { ...doc, _id: '507f1f77bcf86cd799439011' };
      mockModel.create.mockResolvedValue(created);

      const result = await BillingPlanRepository.create(doc);

      expect(mockModel.create).toHaveBeenCalledWith(doc);
      expect(result).toBe(created);
    });

    test('should propagate DB errors', async () => {
      mockModel.create.mockRejectedValue(new Error('E11000 duplicate key'));

      await expect(BillingPlanRepository.create({ planId: 'pro' })).rejects.toThrow('E11000 duplicate key');
    });
  });
});
