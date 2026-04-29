/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for bumpVersionWithRetry in billing.plan.service.js
 */
describe('BillingPlanService — bumpVersionWithRetry unit tests:', () => {
  let BillingPlanService;
  let mockBillingPlanRepository;

  const makeDoc = (overrides = {}) => ({
    _id: '507f1f77bcf86cd799439011',
    planId: 'pro',
    version: 'v2',
    meterQuota: 500000,
    ratios: { scrap: 1 },
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
      deactivateAll: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      count: jest.fn().mockResolvedValue(1),
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

  describe('bumpVersionWithRetry', () => {
    test('should succeed on first attempt when no E11000', async () => {
      const newDoc = makeDoc({ version: 'v2' });
      mockBillingPlanRepository.create.mockResolvedValue([newDoc]);

      const result = await BillingPlanService.bumpVersionWithRetry('pro', { meterQuota: 500000 });

      expect(mockBillingPlanRepository.create).toHaveBeenCalledTimes(1);
      expect(result.version).toBe('v2');
    });

    test('should retry on E11000 and succeed on second attempt', async () => {
      const e11000 = new Error('E11000 duplicate key');
      e11000.code = 11000;
      const newDoc = makeDoc({ version: 'v3' });

      mockBillingPlanRepository.create
        .mockRejectedValueOnce(e11000)
        .mockResolvedValueOnce([newDoc]);

      const result = await BillingPlanService.bumpVersionWithRetry('pro', { meterQuota: 500000 }, { maxAttempts: 3 });

      expect(mockBillingPlanRepository.create).toHaveBeenCalledTimes(2);
      expect(result.version).toBe('v3');
    });

    test('should retry up to maxAttempts then throw', async () => {
      const e11000 = new Error('E11000 duplicate key');
      e11000.code = 11000;
      mockBillingPlanRepository.create.mockRejectedValue(e11000);

      await expect(
        BillingPlanService.bumpVersionWithRetry('pro', { meterQuota: 500000 }, { maxAttempts: 2 }),
      ).rejects.toThrow('E11000');

      expect(mockBillingPlanRepository.create).toHaveBeenCalledTimes(2);
    });

    test('should propagate non-E11000 errors immediately without retry', async () => {
      const networkErr = new Error('network timeout');
      mockBillingPlanRepository.create.mockRejectedValue(networkErr);

      await expect(
        BillingPlanService.bumpVersionWithRetry('pro', { meterQuota: 500000 }, { maxAttempts: 3 }),
      ).rejects.toThrow('network timeout');

      // Should not retry for non-E11000 errors
      expect(mockBillingPlanRepository.create).toHaveBeenCalledTimes(1);
    });

    test('should also retry on E11000 in error message string', async () => {
      const err = new Error('E11000 duplicate key error collection ...');
      // No code property — only message
      const newDoc = makeDoc({ version: 'v2' });
      mockBillingPlanRepository.create
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce([newDoc]);

      const result = await BillingPlanService.bumpVersionWithRetry('pro', { meterQuota: 1 }, { maxAttempts: 3 });
      expect(result.version).toBe('v2');
      expect(mockBillingPlanRepository.create).toHaveBeenCalledTimes(2);
    });

    test('should use default maxAttempts=3 when not specified', async () => {
      const e11000 = new Error('E11000 duplicate key');
      e11000.code = 11000;
      const newDoc = makeDoc();
      mockBillingPlanRepository.create
        .mockRejectedValueOnce(e11000)
        .mockRejectedValueOnce(e11000)
        .mockResolvedValueOnce([newDoc]);

      const result = await BillingPlanService.bumpVersionWithRetry('pro', { meterQuota: 1 });
      expect(result).toBeDefined();
      expect(mockBillingPlanRepository.create).toHaveBeenCalledTimes(3);
    });
  });
});
