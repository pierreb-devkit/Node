/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.meter.outbox repository and schema.
 */
describe('BillingMeterOutbox unit tests:', () => {
  describe('Schema validation', () => {
    let schema;

    beforeEach(async () => {
      const mod = await import('../models/billing.meter.outbox.schema.js');
      schema = mod.default;
    });

    test('accepts a pending outbox row', () => {
      const result = schema.BillingMeterOutbox.safeParse({
        organizationId: '507f1f77bcf86cd799439011',
        idempotencyKey: '507f1f77bcf86cd799439099:initial',
        extrasUnits: 250,
      });

      expect(result.error).toBeFalsy();
      expect(result.data.status).toBe('pending');
      expect(result.data.attempts).toBe(0);
    });

    test('rejects zero extrasUnits', () => {
      const result = schema.BillingMeterOutboxCreate.safeParse({
        organizationId: '507f1f77bcf86cd799439011',
        idempotencyKey: 'key',
        extrasUnits: 0,
      });

      expect(result.error).toBeDefined();
    });
  });

  describe('Repository', () => {
    let BillingMeterOutboxRepository;
    let mockModel;

    const orgId = '507f1f77bcf86cd799439011';
    const outboxId = '607f1f77bcf86cd799439099';

    /**
     * @param {Object} [overrides={}] - Fields to override on the stub outbox row.
     * @returns {Object} A stub outbox row.
     */
    const makeOutbox = (overrides = {}) => ({
      _id: outboxId,
      organizationId: orgId,
      idempotencyKey: '507f1f77bcf86cd799439022:initial',
      extrasUnits: 100,
      status: 'pending',
      attempts: 0,
      lastError: null,
      lastAttemptedAt: null,
      ...overrides,
    });

    beforeEach(async () => {
      jest.resetModules();

      mockModel = {
        create: jest.fn(),
        find: jest.fn(),
        updateOne: jest.fn(),
        findOneAndUpdate: jest.fn(),
      };

      jest.unstable_mockModule('mongoose', () => ({
        default: {
          model: jest.fn(() => mockModel),
        },
      }));

      const mod = await import('../repositories/billing.meter.outbox.repository.js');
      BillingMeterOutboxRepository = mod.default;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('create inserts a pending row', async () => {
      const row = makeOutbox();
      mockModel.create.mockResolvedValue([row]);

      const result = await BillingMeterOutboxRepository.create({
        organizationId: orgId,
        idempotencyKey: row.idempotencyKey,
        extrasUnits: 100,
      });

      expect(mockModel.create).toHaveBeenCalledWith(
        [{
          organizationId: orgId,
          idempotencyKey: row.idempotencyKey,
          extrasUnits: 100,
          status: 'pending',
        }],
        undefined,
      );
      expect(result).toBe(row);
    });

    test('findPendingDue filters pending rows due for retry', async () => {
      const lean = jest.fn().mockResolvedValue([makeOutbox()]);
      const limit = jest.fn(() => ({ lean }));
      const sort = jest.fn(() => ({ limit }));
      mockModel.find.mockReturnValue({ sort });

      await BillingMeterOutboxRepository.findPendingDue(300000, 100);

      expect(mockModel.find).toHaveBeenCalledWith({
        status: 'pending',
        $or: [
          { lastAttemptedAt: null },
          { lastAttemptedAt: { $lt: expect.any(Date) } },
        ],
      });
      expect(sort).toHaveBeenCalledWith({ lastAttemptedAt: 1, createdAt: 1 });
      expect(limit).toHaveBeenCalledWith(100);
      expect(lean).toHaveBeenCalled();
    });

    test('markCommitted sets committed status', async () => {
      mockModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await BillingMeterOutboxRepository.markCommitted(outboxId);

      expect(mockModel.updateOne).toHaveBeenCalledWith(
        { _id: outboxId },
        {
          $set: {
            status: 'committed',
            lastError: null,
            lastAttemptedAt: expect.any(Date),
          },
        },
      );
    });

    test('markFailedAttempt increments attempts and marks failed on fifth attempt', async () => {
      const leanFirst = jest.fn().mockResolvedValue(makeOutbox({ attempts: 5 }));
      const leanSecond = jest.fn().mockResolvedValue(makeOutbox({ attempts: 5, status: 'failed' }));
      mockModel.findOneAndUpdate
        .mockReturnValueOnce({ lean: leanFirst })
        .mockReturnValueOnce({ lean: leanSecond });

      const result = await BillingMeterOutboxRepository.markFailedAttempt(outboxId, new Error('debit failed'));

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      expect(mockModel.findOneAndUpdate.mock.calls[0][1]).toEqual({
        $inc: { attempts: 1 },
        $set: {
          lastError: 'debit failed',
          lastAttemptedAt: expect.any(Date),
        },
      });
      expect(result.status).toBe('failed');
    });
  });
});
