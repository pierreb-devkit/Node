/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.usage.repository.js — meter extensions (PR-N2)
 */
describe('BillingUsageRepository — meter extensions unit tests:', () => {
  let BillingUsageRepository;
  let mockModel;

  const orgId = '507f1f77bcf86cd799439011';
  const weekKey = '2026-W18';

  /**
   * @param {Object} [overrides={}] - Fields to override on the stub usage document.
   * @returns {Object} A stub BillingUsage document.
   */
  const makeUsageDoc = (overrides = {}) => ({
    _id: '507f1f77bcf86cd799439099',
    organizationId: orgId,
    weekKey,
    meterUsed: 0,
    meterQuota: 500000,
    planVersion: 'v1',
    consumedHistoryIds: [],
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateMany: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn(() => mockModel),
        Types: {
          ObjectId: {
            isValid: jest.fn(() => true),
          },
        },
      },
    }));

    const mod = await import('../repositories/billing.usage.repository.js');
    BillingUsageRepository = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('findByWeek', () => {
    test('should call findOne with organizationId and weekKey, return lean doc', async () => {
      const doc = makeUsageDoc();
      const leanMock = jest.fn().mockResolvedValue(doc);
      mockModel.findOne.mockReturnValue({ lean: leanMock });

      const result = await BillingUsageRepository.findByWeek(orgId, weekKey);

      expect(mockModel.findOne).toHaveBeenCalledWith({ organizationId: orgId, weekKey });
      expect(leanMock).toHaveBeenCalled();
      expect(result).toBe(doc);
    });

    test('should return null when no document found', async () => {
      const leanMock = jest.fn().mockResolvedValue(null);
      mockModel.findOne.mockReturnValue({ lean: leanMock });

      const result = await BillingUsageRepository.findByWeek(orgId, '2026-W99');
      expect(result).toBeNull();
    });

    test('should return null when organizationId fails isValid check', async () => {
      // Mock isValid to reject the orgId in this test's already-loaded module instance.
      // Because the module is already loaded, we verify via the mock's behavior.
      const { default: mongoose } = await import('mongoose');
      const origIsValid = mongoose.Types.ObjectId.isValid;
      mongoose.Types.ObjectId.isValid = jest.fn(() => false);

      try {
        const result = await BillingUsageRepository.findByWeek('not-valid-id', weekKey);
        expect(result).toBeNull();
      } finally {
        mongoose.Types.ObjectId.isValid = origIsValid;
      }
    });
  });

  describe('incrementMeter', () => {
    test('should call findOneAndUpdate with correct filter including idempotency key', async () => {
      const updatedDoc = makeUsageDoc({ meterUsed: 100, consumedHistoryIds: ['hist_001'] });
      mockModel.findOneAndUpdate.mockResolvedValue(updatedDoc);

      const result = await BillingUsageRepository.incrementMeter(
        orgId,
        weekKey,
        100,
        { scrap: 100 },
        'hist_001',
        { meterQuota: 500000, planVersion: 'v1', resetAt: new Date(), month: '2026-05' },
      );

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: orgId,
          weekKey,
          consumedHistoryIds: { $ne: 'hist_001' },
        }),
        expect.objectContaining({
          $inc: expect.objectContaining({ meterUsed: 100 }),
          $push: { consumedHistoryIds: 'hist_001' },
          $setOnInsert: expect.any(Object),
        }),
        expect.objectContaining({ upsert: true, returnDocument: 'after' }),
      );
      expect(result).toBe(updatedDoc);
    });

    test('should include breakdown in $inc payload', async () => {
      const updatedDoc = makeUsageDoc({ meterUsed: 150 });
      let capturedUpdate;
      mockModel.findOneAndUpdate.mockImplementation((filter, update) => {
        capturedUpdate = update;
        return Promise.resolve(updatedDoc);
      });

      await BillingUsageRepository.incrementMeter(
        orgId,
        weekKey,
        150,
        { scrap: 100, autofix: 50 },
        'hist_002',
        {},
      );

      expect(capturedUpdate.$inc['meterBreakdown.scrap']).toBe(100);
      expect(capturedUpdate.$inc['meterBreakdown.autofix']).toBe(50);
    });

    test('should drop breakdown entries with non-positive or non-finite values', async () => {
      let capturedUpdate;
      mockModel.findOneAndUpdate.mockImplementation((filter, update) => {
        capturedUpdate = update;
        return Promise.resolve(makeUsageDoc());
      });

      await BillingUsageRepository.incrementMeter(
        orgId,
        weekKey,
        10,
        { good: 10, zero: 0, negative: -5, infinite: Infinity, nan: NaN },
        'hist_invalid_breakdown',
        {},
      );

      // Only 'good' should be included
      expect(capturedUpdate.$inc['meterBreakdown.good']).toBe(10);
      expect(capturedUpdate.$inc['meterBreakdown.zero']).toBeUndefined();
      expect(capturedUpdate.$inc['meterBreakdown.negative']).toBeUndefined();
      expect(capturedUpdate.$inc['meterBreakdown.infinite']).toBeUndefined();
      expect(capturedUpdate.$inc['meterBreakdown.nan']).toBeUndefined();
    });

    test('should return null when idempotencyKey already present (replay)', async () => {
      // findOneAndUpdate returns null when filter does not match (consumedHistoryIds already contains key)
      mockModel.findOneAndUpdate.mockResolvedValue(null);

      const result = await BillingUsageRepository.incrementMeter(
        orgId,
        weekKey,
        100,
        {},
        'hist_replay',
        {},
      );

      expect(result).toBeNull();
    });

    test('incrementMeter same idempotencyKey twice → second returns null', async () => {
      mockModel.findOneAndUpdate
        .mockResolvedValueOnce(makeUsageDoc({ meterUsed: 100, consumedHistoryIds: ['hist_x'] }))
        .mockResolvedValueOnce(null); // second: replay

      const r1 = await BillingUsageRepository.incrementMeter(orgId, weekKey, 100, {}, 'hist_x', {});
      const r2 = await BillingUsageRepository.incrementMeter(orgId, weekKey, 100, {}, 'hist_x', {});

      expect(r1).toBeDefined();
      expect(r2).toBeNull();
    });

    test('should handle E11000 race via retry without upsert', async () => {
      const e11000 = new Error('E11000 duplicate key');
      e11000.code = 11000;
      const retryDoc = makeUsageDoc({ meterUsed: 100 });

      mockModel.findOneAndUpdate
        .mockRejectedValueOnce(e11000)
        .mockResolvedValueOnce(retryDoc);

      const result = await BillingUsageRepository.incrementMeter(
        orgId,
        weekKey,
        100,
        {},
        'hist_race',
        {},
      );

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      // Second call should not have upsert
      const secondCall = mockModel.findOneAndUpdate.mock.calls[1];
      expect(secondCall[2]?.upsert).toBeUndefined();
      expect(result).toBe(retryDoc);
    });

    test('should propagate non-E11000 errors', async () => {
      const dbErr = new Error('connection lost');
      mockModel.findOneAndUpdate.mockRejectedValue(dbErr);

      await expect(
        BillingUsageRepository.incrementMeter(orgId, weekKey, 100, {}, 'hist_err', {}),
      ).rejects.toThrow('connection lost');
    });

    test('should set $setOnInsert snapshot from baseSnapshot', async () => {
      const now = new Date();
      let capturedUpdate;
      mockModel.findOneAndUpdate.mockImplementation((filter, update) => {
        capturedUpdate = update;
        return Promise.resolve(makeUsageDoc());
      });

      await BillingUsageRepository.incrementMeter(
        orgId,
        weekKey,
        50,
        {},
        'hist_snap',
        { meterQuota: 999, planVersion: 'v7', resetAt: now, month: '2026-05' },
      );

      expect(capturedUpdate.$setOnInsert.meterQuota).toBe(999);
      expect(capturedUpdate.$setOnInsert.planVersion).toBe('v7');
      expect(capturedUpdate.$setOnInsert.resetAt).toBe(now);
      expect(capturedUpdate.$setOnInsert.month).toBe('2026-05');
    });

    test('should initialize alertedAt80, alertedAt100, meterBreakdown in $setOnInsert', async () => {
      let capturedUpdate;
      mockModel.findOneAndUpdate.mockImplementation((filter, update) => {
        capturedUpdate = update;
        return Promise.resolve(makeUsageDoc());
      });

      await BillingUsageRepository.incrementMeter(
        orgId,
        weekKey,
        100,
        {},
        'hist_defaults',
        { meterQuota: 500, planVersion: 'v1', resetAt: new Date(), month: '2026-05' },
      );

      expect(capturedUpdate.$setOnInsert.alertedAt80).toBeNull();
      expect(capturedUpdate.$setOnInsert.alertedAt100).toBeNull();
      expect(capturedUpdate.$setOnInsert.meterBreakdown).toEqual({});
    });

    test('should produce a valid YYYY-MM month string when baseSnapshot.month is absent', async () => {
      let capturedUpdate;
      mockModel.findOneAndUpdate.mockImplementation((filter, update) => {
        capturedUpdate = update;
        return Promise.resolve(makeUsageDoc());
      });

      // Pass a baseSnapshot without a month field
      await BillingUsageRepository.incrementMeter(orgId, weekKey, 50, {}, 'hist_nomonth', {
        meterQuota: 100,
        planVersion: null,
        resetAt: null,
      });

      // month must be YYYY-MM (e.g. '2026-04'), not 'YYYY-W...'
      expect(capturedUpdate.$setOnInsert.month).toMatch(/^\d{4}-\d{2}$/);
    });

    test('should return null when organizationId fails isValid check', async () => {
      const { default: mongoose } = await import('mongoose');
      const origIsValid = mongoose.Types.ObjectId.isValid;
      mongoose.Types.ObjectId.isValid = jest.fn(() => false);

      try {
        const result = await BillingUsageRepository.incrementMeter('bad-id', weekKey, 100, {}, 'key', {});
        expect(result).toBeNull();
      } finally {
        mongoose.Types.ObjectId.isValid = origIsValid;
      }
    });
  });

  describe('archiveOtherWeeks', () => {
    test('should call updateMany excluding currentWeekKey on docs with archivedAt unset/null', async () => {
      mockModel.updateMany.mockResolvedValue({ modifiedCount: 2 });
      const archivedAt = new Date('2026-04-28T00:00:00Z');

      const result = await BillingUsageRepository.archiveOtherWeeks(orgId, weekKey, archivedAt);

      expect(mockModel.updateMany).toHaveBeenCalledWith(
        {
          organizationId: orgId,
          weekKey: { $ne: weekKey },
          archivedAt: null,
        },
        { $set: { archivedAt } },
      );
      expect(result.modifiedCount).toBe(2);
    });

    test('should return modifiedCount=0 when nothing to archive', async () => {
      mockModel.updateMany.mockResolvedValue({ modifiedCount: 0 });

      const result = await BillingUsageRepository.archiveOtherWeeks(orgId, weekKey, new Date());
      expect(result.modifiedCount).toBe(0);
    });
  });

  describe('upsertWeekSnapshot', () => {
    test('should call findOneAndUpdate with upsert and $setOnInsert', async () => {
      const snapshotFields = {
        organizationId: orgId,
        weekKey,
        month: '2026-05',
        meterUsed: 0,
        meterQuota: 500000,
        planVersion: 'v1',
        meterBreakdown: {},
        resetAt: new Date(),
        alertedAt80: null,
        alertedAt100: null,
        consumedHistoryIds: [],
      };
      const newDoc = makeUsageDoc();
      mockModel.findOneAndUpdate.mockResolvedValue(newDoc);

      const result = await BillingUsageRepository.upsertWeekSnapshot(orgId, weekKey, snapshotFields);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { organizationId: orgId, weekKey },
        { $setOnInsert: snapshotFields },
        expect.objectContaining({ upsert: true, returnDocument: 'after' }),
      );
      expect(result).toBe(newDoc);
    });
  });

  describe('markThreshold', () => {
    test('should call updateOne with field null filter and $set to current date', async () => {
      mockModel.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });

      const result = await BillingUsageRepository.markThreshold('507f1f77bcf86cd799439099', 'alertedAt80');

      expect(mockModel.updateOne).toHaveBeenCalledWith(
        { _id: '507f1f77bcf86cd799439099', alertedAt80: null },
        { $set: { alertedAt80: expect.any(Date) } },
      );
      expect(result.modifiedCount).toBe(1);
    });

    test('should use the correct field name for alertedAt100', async () => {
      mockModel.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });

      await BillingUsageRepository.markThreshold('507f1f77bcf86cd799439099', 'alertedAt100');

      expect(mockModel.updateOne).toHaveBeenCalledWith(
        { _id: '507f1f77bcf86cd799439099', alertedAt100: null },
        { $set: { alertedAt100: expect.any(Date) } },
      );
    });

    test('should return modifiedCount=0 when threshold already set (idempotent)', async () => {
      mockModel.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 0 });

      const result = await BillingUsageRepository.markThreshold('507f1f77bcf86cd799439099', 'alertedAt80');
      expect(result.modifiedCount).toBe(0);
    });
  });
});
