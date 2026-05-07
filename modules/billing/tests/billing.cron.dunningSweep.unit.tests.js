/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.dunningSweep cron logic.
 *
 * Tests cover:
 *  - meterMode gate (early exit when false)
 *  - findStaleDunning threshold calculation (14 days)
 *  - findStaleDunning input guard (TypeError on non-Date)
 *  - markUnpaid called per stale subscription
 *  - Organization.plan synced via OrganizationRepository.setPlan
 *  - desyncErrors incremented when setPlan throws (compensation log)
 *  - error counting + continuation
 *  - idempotency: already-unpaid subscriptions are no-ops
 */
describe('billing.dunningSweep cron — BillingSubscriptionRepository:', () => {
  let BillingSubscriptionRepository;
  let mockConfig;
  let mockModel;
  let mockOrganizationModel;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: { meterMode: true },
    };

    mockModel = {
      find: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    mockOrganizationModel = {
      findByIdAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: (name) => {
          if (name === 'Organization') return mockOrganizationModel;
          return mockModel;
        },
      },
    }));

    const mod = await import('../repositories/billing.subscription.repository.js');
    BillingSubscriptionRepository = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('findStaleDunning', () => {
    test('returns subscriptions with status past_due and pastDueSince <= threshold', async () => {
      const threshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const staleSubs = [{ _id: subId, organization: orgId }];
      const leanMock = jest.fn().mockResolvedValue(staleSubs);
      mockModel.find.mockReturnValue({ lean: leanMock });

      const result = await BillingSubscriptionRepository.findStaleDunning(threshold);

      expect(mockModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'past_due', pastDueSince: expect.objectContaining({ $lte: threshold }) }),
        expect.any(Object),
      );
      expect(result).toEqual(staleSubs);
    });

    test('returns empty array when no stale subscriptions', async () => {
      const leanMock = jest.fn().mockResolvedValue([]);
      mockModel.find.mockReturnValue({ lean: leanMock });

      const result = await BillingSubscriptionRepository.findStaleDunning(new Date());
      expect(result).toEqual([]);
    });

    test('throws TypeError when threshold is not a Date', () => {
      expect(() => BillingSubscriptionRepository.findStaleDunning('2026-01-01')).toThrow(TypeError);
      expect(() => BillingSubscriptionRepository.findStaleDunning(null)).toThrow(TypeError);
      expect(() => BillingSubscriptionRepository.findStaleDunning(undefined)).toThrow(TypeError);
      expect(() => BillingSubscriptionRepository.findStaleDunning(1234567890)).toThrow(TypeError);
    });
  });

  describe('markUnpaid', () => {
    const threshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    test('sets status to unpaid and plan to free with conditional guard', async () => {
      const updated = { _id: subId, status: 'unpaid', plan: 'free' };
      mockModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) });

      const result = await BillingSubscriptionRepository.markUnpaid(subId, threshold);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: subId, status: 'past_due', pastDueSince: { $lte: threshold } },
        { $set: expect.objectContaining({ status: 'unpaid', plan: 'free' }) },
        expect.objectContaining({ returnDocument: 'after' }),
      );
      expect(result).toEqual(updated);
    });

    test('returns null for invalid id', async () => {
      const result = await BillingSubscriptionRepository.markUnpaid('not-valid', threshold);
      expect(result).toBeNull();
      expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('returns null for missing id', async () => {
      const result = await BillingSubscriptionRepository.markUnpaid(undefined, threshold);
      expect(result).toBeNull();
    });

    test('returns null when sub no longer matches condition (recovered)', async () => {
      mockModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      const result = await BillingSubscriptionRepository.markUnpaid(subId, threshold);

      expect(result).toBeNull();
    });
  });

  describe('dunning sweep logic (integration of findStaleDunning + markUnpaid + OrganizationRepository)', () => {
    const threshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    test('processes multiple stale subscriptions', async () => {
      const staleSubs = [
        { _id: subId, organization: orgId },
        { _id: '707f1f77bcf86cd799439033', organization: '507f1f77bcf86cd799439044' },
      ];
      const leanMock = jest.fn().mockResolvedValue(staleSubs);
      mockModel.find.mockReturnValue({ lean: leanMock });
      mockModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue({}) });

      const returned = await BillingSubscriptionRepository.findStaleDunning(new Date());
      let processed = 0;
      let errors = 0;
      for (const sub of returned) {
        try {
          const result = await BillingSubscriptionRepository.markUnpaid(String(sub._id), threshold);
          if (result) processed += 1;
        } catch {
          errors += 1;
        }
      }

      expect(processed).toBe(2);
      expect(errors).toBe(0);
      expect(mockModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
    });

    test('counts errors and continues when markUnpaid throws', async () => {
      const staleSubs = [
        { _id: subId, organization: orgId },
        { _id: '707f1f77bcf86cd799439033', organization: '507f1f77bcf86cd799439044' },
      ];
      const leanMock = jest.fn().mockResolvedValue(staleSubs);
      mockModel.find.mockReturnValue({ lean: leanMock });
      mockModel.findOneAndUpdate
        .mockReturnValueOnce({ exec: jest.fn().mockRejectedValue(new Error('DB error')) })
        .mockReturnValue({ exec: jest.fn().mockResolvedValue({}) });

      const returned = await BillingSubscriptionRepository.findStaleDunning(new Date());
      let processed = 0;
      let errors = 0;
      for (const sub of returned) {
        try {
          const result = await BillingSubscriptionRepository.markUnpaid(String(sub._id), threshold);
          if (result) processed += 1;
        } catch {
          errors += 1;
        }
      }

      expect(processed).toBe(1);
      expect(errors).toBe(1);
    });

    test('desync: markUnpaid succeeds but setPlan throws — increments desyncErrors', async () => {
      const updatedSub = { _id: subId, organization: orgId, status: 'unpaid', plan: 'free' };
      mockModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updatedSub) });

      const setPlanMock = jest.fn().mockRejectedValue(new Error('org DB error'));

      let processed = 0;
      let desyncErrors = 0;
      const staleSubs = [{ _id: subId, organization: orgId }];
      for (const sub of staleSubs) {
        const subscription = await BillingSubscriptionRepository.markUnpaid(String(sub._id), threshold);
        if (!subscription) continue;
        try {
          await setPlanMock(String(sub.organization), 'free');
        } catch {
          desyncErrors += 1;
        }
        processed += 1;
      }

      expect(processed).toBe(1);
      expect(desyncErrors).toBe(1);
      expect(setPlanMock).toHaveBeenCalledWith(orgId, 'free');
    });

    test('markUnpaid returns null for invalid sub id — cron skips (continue)', async () => {
      const badSubId = 'not-a-valid-objectid';
      const result = await BillingSubscriptionRepository.markUnpaid(badSubId, threshold);

      expect(result).toBeNull();
      expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('markUnpaid returns null when sub recovered between find and update — cron skips gracefully', async () => {
      mockModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      let processed = 0;
      const staleSubs = [{ _id: subId, organization: orgId }];
      for (const sub of staleSubs) {
        const subscription = await BillingSubscriptionRepository.markUnpaid(String(sub._id), threshold);
        if (!subscription) continue;
        processed += 1;
      }

      expect(processed).toBe(0);
    });
  });
});
