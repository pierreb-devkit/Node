/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.subscription.repository.js
 * Covers: findStaleDunning + markUnpaid (PR-N5 additions)
 */
describe('BillingSubscriptionRepository unit tests:', () => {
  let BillingSubscriptionRepository;
  let mockModel;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      deleteOne: jest.fn(),
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: jest.fn(() => mockModel),
      },
    }));

    const mod = await import('../repositories/billing.subscription.repository.js');
    BillingSubscriptionRepository = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── findStaleDunning ──────────────────────────────────────────────────────

  describe('findStaleDunning', () => {
    test('queries for past_due status and pastDueSince <= threshold', async () => {
      const threshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const staleSubs = [{ _id: subId, organization: orgId }];
      const leanMock = jest.fn().mockResolvedValue(staleSubs);
      mockModel.find.mockReturnValue({ lean: leanMock });

      const result = await BillingSubscriptionRepository.findStaleDunning(threshold);

      expect(mockModel.find).toHaveBeenCalledWith(
        {
          status: 'past_due',
          pastDueSince: { $ne: null, $lte: threshold },
        },
        { _id: 1, organization: 1 },
      );
      expect(leanMock).toHaveBeenCalled();
      expect(result).toEqual(staleSubs);
    });

    test('returns empty array when no stale subscriptions exist', async () => {
      const leanMock = jest.fn().mockResolvedValue([]);
      mockModel.find.mockReturnValue({ lean: leanMock });

      const result = await BillingSubscriptionRepository.findStaleDunning(new Date());
      expect(result).toEqual([]);
    });

    test('returns multiple stale subscriptions', async () => {
      const staleSubs = [
        { _id: subId, organization: orgId },
        { _id: '707f1f77bcf86cd799439033', organization: '507f1f77bcf86cd799439044' },
      ];
      const leanMock = jest.fn().mockResolvedValue(staleSubs);
      mockModel.find.mockReturnValue({ lean: leanMock });

      const result = await BillingSubscriptionRepository.findStaleDunning(new Date());
      expect(result).toHaveLength(2);
    });

    test('uses lean() for performance (no population)', async () => {
      const leanMock = jest.fn().mockResolvedValue([]);
      mockModel.find.mockReturnValue({ lean: leanMock });

      await BillingSubscriptionRepository.findStaleDunning(new Date());

      expect(leanMock).toHaveBeenCalled();
    });
  });

  // ── markUnpaid ────────────────────────────────────────────────────────────

  describe('markUnpaid', () => {
    test('sets status to unpaid and plan to free atomically', async () => {
      const updated = { _id: subId, status: 'unpaid', plan: 'free' };
      mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) });

      const result = await BillingSubscriptionRepository.markUnpaid(subId);

      expect(mockModel.findByIdAndUpdate).toHaveBeenCalledWith(
        subId,
        { $set: { status: 'unpaid', plan: 'free' } },
        { returnDocument: 'after', runValidators: true },
      );
      expect(result).toEqual(updated);
    });

    test('returns null for invalid ObjectId string', async () => {
      const result = await BillingSubscriptionRepository.markUnpaid('not-a-valid-id');
      expect(result).toBeNull();
      expect(mockModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    test('returns null for undefined id', async () => {
      const result = await BillingSubscriptionRepository.markUnpaid(undefined);
      expect(result).toBeNull();
      expect(mockModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    test('returns null for null id', async () => {
      const result = await BillingSubscriptionRepository.markUnpaid(null);
      expect(result).toBeNull();
      expect(mockModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    test('is idempotent — already-unpaid subscription can be called again without error', async () => {
      const already = { _id: subId, status: 'unpaid', plan: 'free' };
      mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(already) });

      const result = await BillingSubscriptionRepository.markUnpaid(subId);

      expect(result.status).toBe('unpaid');
      expect(result.plan).toBe('free');
    });

    test('uses returnDocument: after to return the updated document', async () => {
      const updated = { _id: subId, status: 'unpaid', plan: 'free' };
      mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) });

      await BillingSubscriptionRepository.markUnpaid(subId);

      const callArgs = mockModel.findByIdAndUpdate.mock.calls[0];
      expect(callArgs[2]).toMatchObject({ returnDocument: 'after' });
    });
  });

  // ── findAllDueForReset (existing — smoke test) ────────────────────────────

  describe('findAllDueForReset', () => {
    test('queries for active/trialing status within window', async () => {
      const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const to = new Date();
      const leanMock = jest.fn().mockResolvedValue([]);
      mockModel.find.mockReturnValue({ lean: leanMock });

      await BillingSubscriptionRepository.findAllDueForReset(from, to);

      expect(mockModel.find).toHaveBeenCalledWith(
        {
          status: { $in: ['active', 'trialing'] },
          currentPeriodStart: { $gte: from, $lte: to },
        },
        { organization: 1, currentPeriodStart: 1 },
      );
    });
  });
});
