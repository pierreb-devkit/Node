/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import schema from '../models/billing.usage.schema.js';

/**
 * Unit tests
 */
describe('BillingUsage unit tests:', () => {
  describe('Schema validation', () => {
    let usage;

    beforeEach(() => {
      usage = {
        organizationId: '507f1f77bcf86cd799439011',
        month: '2026-03',
        counters: { executions: 10 },
      };
    });

    test('should be valid with correct data', () => {
      const result = schema.BillingUsage.safeParse(usage);
      expect(result.error).toBeFalsy();
      expect(result.data.organizationId).toBe('507f1f77bcf86cd799439011');
      expect(result.data.month).toBe('2026-03');
      expect(result.data.counters.executions).toBe(10);
    });

    test('should show error when organizationId is missing', () => {
      usage.organizationId = '';
      const result = schema.BillingUsage.safeParse(usage);
      expect(result.error).toBeDefined();
    });

    test('should show error when organizationId is invalid', () => {
      usage.organizationId = 'not-valid';
      const result = schema.BillingUsage.safeParse(usage);
      expect(result.error).toBeDefined();
    });

    test('should show error when month format is invalid', () => {
      usage.month = '2026/03';
      const result = schema.BillingUsage.safeParse(usage);
      expect(result.error).toBeDefined();
    });

    test('should show error when month is missing', () => {
      delete usage.month;
      const result = schema.BillingUsage.safeParse(usage);
      expect(result.error).toBeDefined();
    });

    test('should reject semantically invalid month 2026-00', () => {
      usage.month = '2026-00';
      const result = schema.BillingUsage.safeParse(usage);
      expect(result.error).toBeDefined();
    });

    test('should reject semantically invalid month 2026-13', () => {
      usage.month = '2026-13';
      const result = schema.BillingUsage.safeParse(usage);
      expect(result.error).toBeDefined();
    });

    test('should default counters to empty object', () => {
      delete usage.counters;
      const result = schema.BillingUsage.safeParse(usage);
      expect(result.error).toBeFalsy();
      expect(result.data.counters).toEqual({});
    });
  });

  describe('Schema validation — compute fields (weekKey)', () => {
    let usage;

    beforeEach(() => {
      usage = {
        organizationId: '507f1f77bcf86cd799439011',
        month: '2026-03',
      };
    });

    test('should accept a valid ISO weekKey YYYY-Www', () => {
      const result = schema.BillingUsage.safeParse({ ...usage, weekKey: '2026-W18' });
      expect(result.error).toBeFalsy();
      expect(result.data.weekKey).toBe('2026-W18');
    });

    test('should reject weekKey with wrong format (missing W prefix)', () => {
      const result = schema.BillingUsage.safeParse({ ...usage, weekKey: '2026-18' });
      expect(result.error).toBeDefined();
    });

    test('should reject weekKey with invalid week number 00', () => {
      const result = schema.BillingUsage.safeParse({ ...usage, weekKey: '2026-W00' });
      expect(result.error).toBeDefined();
    });

    test('should reject weekKey with week number > 53', () => {
      const result = schema.BillingUsage.safeParse({ ...usage, weekKey: '2026-W54' });
      expect(result.error).toBeDefined();
    });

    test('should allow usage document without weekKey (non-compute downstream)', () => {
      const result = schema.BillingUsage.safeParse(usage);
      expect(result.error).toBeFalsy();
      expect(result.data.weekKey).toBeUndefined();
    });
  });

  describe('Schema validation — consumedHistoryIds', () => {
    const objectIdRegex = /^[a-f\d]{24}$/i;

    test('should accept an empty consumedHistoryIds array', () => {
      const result = schema.BillingUsage.safeParse({
        organizationId: '507f1f77bcf86cd799439011',
        month: '2026-03',
        consumedHistoryIds: [],
      });
      expect(result.error).toBeFalsy();
      expect(result.data.consumedHistoryIds).toEqual([]);
    });

    test('should accept valid ObjectId strings in consumedHistoryIds', () => {
      const result = schema.BillingUsage.safeParse({
        organizationId: '507f1f77bcf86cd799439011',
        month: '2026-03',
        consumedHistoryIds: ['507f1f77bcf86cd799439012', '507f1f77bcf86cd799439013'],
      });
      expect(result.error).toBeFalsy();
      for (const id of result.data.consumedHistoryIds) {
        expect(objectIdRegex.test(id)).toBe(true);
      }
    });

    test('should reject invalid ObjectId strings in consumedHistoryIds', () => {
      const result = schema.BillingUsage.safeParse({
        organizationId: '507f1f77bcf86cd799439011',
        month: '2026-03',
        consumedHistoryIds: ['not-an-objectid'],
      });
      expect(result.error).toBeDefined();
    });

    test('should default consumedHistoryIds to empty array when missing', () => {
      const result = schema.BillingUsage.safeParse({
        organizationId: '507f1f77bcf86cd799439011',
        month: '2026-03',
      });
      expect(result.error).toBeFalsy();
      expect(result.data.consumedHistoryIds).toEqual([]);
    });
  });

  describe('Service layer', () => {
    let BillingUsageService;
    let mockUsageRepository;

    const orgId = '507f1f77bcf86cd799439011';

    beforeEach(async () => {
      jest.resetModules();

      mockUsageRepository = {
        get: jest.fn(),
        increment: jest.fn(),
        reset: jest.fn(),
      };

      jest.unstable_mockModule('../repositories/billing.usage.repository.js', () => ({
        default: mockUsageRepository,
      }));

      const mod = await import('../services/billing.usage.service.js');
      BillingUsageService = mod.default;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('increment should create document on first call (upsert)', async () => {
      const created = { organizationId: orgId, month: '2026-03', counters: { executions: 1 } };
      mockUsageRepository.increment.mockResolvedValue(created);

      const result = await BillingUsageService.increment(orgId, 'executions', 1);

      expect(mockUsageRepository.increment).toHaveBeenCalledWith(orgId, expect.stringMatching(/^\d{4}-\d{2}$/), 'executions', 1);
      expect(result.counters.executions).toBe(1);
    });

    test('increment should atomically increase counter', async () => {
      const updated = { organizationId: orgId, month: '2026-03', counters: { executions: 5 } };
      mockUsageRepository.increment.mockResolvedValue(updated);

      const result = await BillingUsageService.increment(orgId, 'executions', 3);

      expect(result.counters.executions).toBe(5);
    });

    test('get should return empty counters for new org/month', async () => {
      mockUsageRepository.get.mockResolvedValue(null);

      const result = await BillingUsageService.get(orgId);

      expect(result.counters).toEqual({});
      expect(result.organizationId).toBe(orgId);
    });

    test('get should return existing usage document', async () => {
      const existing = { organizationId: orgId, month: '2026-03', counters: { executions: 42, aiCalls: 5 } };
      mockUsageRepository.get.mockResolvedValue(existing);

      const result = await BillingUsageService.get(orgId);

      expect(result.counters.executions).toBe(42);
      expect(result.counters.aiCalls).toBe(5);
    });

    test('reset should clear counters', async () => {
      const resetDoc = { organizationId: orgId, month: '2026-03', counters: {} };
      mockUsageRepository.reset.mockResolvedValue(resetDoc);

      const result = await BillingUsageService.reset(orgId);

      expect(mockUsageRepository.reset).toHaveBeenCalledWith(orgId, expect.stringMatching(/^\d{4}-\d{2}$/));
      expect(result.counters).toEqual({});
    });
  });
});
