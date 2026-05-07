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
      findOneAndUpdate: jest.fn(),
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
    const threshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    test('sets status to unpaid and plan to free with conditional guard', async () => {
      const updated = { _id: subId, status: 'unpaid', plan: 'free' };
      mockModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) });

      const result = await BillingSubscriptionRepository.markUnpaid(subId, threshold);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: subId, status: 'past_due', pastDueSince: { $lte: threshold } },
        { $set: expect.objectContaining({ status: 'unpaid', plan: 'free' }) },
        { returnDocument: 'after', runValidators: true },
      );
      expect(result).toEqual(updated);
    });

    test('returns null for invalid ObjectId string', async () => {
      const result = await BillingSubscriptionRepository.markUnpaid('not-a-valid-id', threshold);
      expect(result).toBeNull();
      expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('returns null for undefined id', async () => {
      const result = await BillingSubscriptionRepository.markUnpaid(undefined, threshold);
      expect(result).toBeNull();
      expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('returns null for null id', async () => {
      const result = await BillingSubscriptionRepository.markUnpaid(null, threshold);
      expect(result).toBeNull();
      expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('throws TypeError when threshold is not a Date', async () => {
      expect(() => BillingSubscriptionRepository.markUnpaid(subId, '2026-01-01')).toThrow(TypeError);
      expect(() => BillingSubscriptionRepository.markUnpaid(subId, null)).toThrow(TypeError);
    });

    test('returns null when sub no longer matches (recovered between find and update)', async () => {
      mockModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      const result = await BillingSubscriptionRepository.markUnpaid(subId, threshold);

      expect(result).toBeNull();
    });

    test('uses returnDocument: after to return the updated document', async () => {
      const updated = { _id: subId, status: 'unpaid', plan: 'free' };
      mockModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) });

      await BillingSubscriptionRepository.markUnpaid(subId, threshold);

      const callArgs = mockModel.findOneAndUpdate.mock.calls[0];
      expect(callArgs[2]).toMatchObject({ returnDocument: 'after' });
    });
  });

  // ── updateIfEventNewer ────────────────────────────────────────────────────

  describe('updateIfEventNewer', () => {
    test('updates when lastSubscriptionEventCreatedAt is null (first event)', async () => {
      const updated = { _id: subId, status: 'canceled', lastSubscriptionEventCreatedAt: 1000, lastSubscriptionEventId: 'evt_abc' };
      const populateMock = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) });
      mockModel.findOneAndUpdate.mockReturnValue({ populate: populateMock });

      const result = await BillingSubscriptionRepository.updateIfEventNewer(subId, 1000, 'evt_abc', { status: 'canceled' });

      // Default family is 'subscription' — guard + write use lastSubscriptionEvent* fields
      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: subId,
          $or: [
            { lastSubscriptionEventCreatedAt: { $exists: false } },
            { lastSubscriptionEventCreatedAt: null },
            { lastSubscriptionEventCreatedAt: { $lt: 1000 } },
            {
              lastSubscriptionEventCreatedAt: 1000,
              $or: [
                { lastSubscriptionEventId: { $exists: false } },
                { lastSubscriptionEventId: null },
                { lastSubscriptionEventId: { $lt: 'evt_abc' } },
              ],
            },
          ],
        },
        {
          $set: {
            status: 'canceled',
            lastSubscriptionEventCreatedAt: 1000,
            lastSubscriptionEventId: 'evt_abc',
          },
        },
        { returnDocument: 'after', runValidators: true },
      );
      expect(result).toEqual(updated);
    });

    test('returns null when event is stale (older than stored)', async () => {
      const populateMock = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      mockModel.findOneAndUpdate.mockReturnValue({ populate: populateMock });

      const result = await BillingSubscriptionRepository.updateIfEventNewer(subId, 500, 'evt_old', { status: 'canceled' });

      expect(result).toBeNull();
    });

    test('returns null for invalid id', async () => {
      const result = await BillingSubscriptionRepository.updateIfEventNewer('not-valid', 1000, 'evt_abc', {});
      expect(result).toBeNull();
      expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('same-second events: lex-earlier eventId is rejected (tiebreaker guard)', async () => {
      const populateMock = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      mockModel.findOneAndUpdate.mockReturnValue({ populate: populateMock });

      const result = await BillingSubscriptionRepository.updateIfEventNewer(subId, 1000, 'evt_aaaa', { status: 'active' });

      expect(result).toBeNull();
      const filter = mockModel.findOneAndUpdate.mock.calls[0][0];
      const sameSecondBranch = filter.$or[3];
      // Default family is 'subscription' — same-second branch uses per-family fields
      expect(sameSecondBranch.lastSubscriptionEventCreatedAt).toBe(1000);
      expect(sameSecondBranch.$or[2].lastSubscriptionEventId.$lt).toBe('evt_aaaa');
    });
  });

  // ── findPlan ──────────────────────────────────────────────────────────────

  describe('findPlan', () => {
    test('returns plan field for a valid organizationId', async () => {
      const planDoc = { _id: subId, plan: 'pro' };
      const execMock = jest.fn().mockResolvedValue(planDoc);
      const leanMock = jest.fn().mockReturnValue({ exec: execMock });
      mockModel.findOne.mockReturnValue({ lean: leanMock });

      const result = await BillingSubscriptionRepository.findPlan(orgId);

      expect(mockModel.findOne).toHaveBeenCalledWith(
        { organization: orgId },
        { plan: 1 },
      );
      expect(leanMock).toHaveBeenCalled();
      expect(result).toEqual(planDoc);
    });

    test('returns null for an invalid organizationId without querying', async () => {
      const result = await BillingSubscriptionRepository.findPlan('not-a-valid-id');

      expect(result).toBeNull();
      expect(mockModel.findOne).not.toHaveBeenCalled();
    });

    test('returns null when no subscription exists for the organization', async () => {
      const execMock = jest.fn().mockResolvedValue(null);
      const leanMock = jest.fn().mockReturnValue({ exec: execMock });
      mockModel.findOne.mockReturnValue({ lean: leanMock });

      const result = await BillingSubscriptionRepository.findPlan(orgId);

      expect(result).toBeNull();
    });
  });

  describe('findAllDueForResetByLastReset', () => {
    test('includes subscriptions with lastResetAt=null', async () => {
      const now = new Date('2026-05-01T12:00:00.000Z');
      const leanMock = jest.fn().mockResolvedValue([{ organization: orgId, lastResetAt: null }]);
      mockModel.find.mockReturnValue({ lean: leanMock });

      const result = await BillingSubscriptionRepository.findAllDueForResetByLastReset(now);

      expect(mockModel.find).toHaveBeenCalledWith(
        {
          status: { $in: ['active', 'trialing'] },
          currentPeriodStart: { $ne: null },
          $or: [
            { lastResetAt: null },
            { lastResetAt: { $lt: new Date('2026-04-24T12:00:00.000Z') } },
          ],
        },
        { organization: 1, currentPeriodStart: 1, lastResetAt: 1 },
      );
      expect(result).toEqual([{ organization: orgId, lastResetAt: null }]);
    });

    test('includes subscriptions with lastResetAt older than 7 days', async () => {
      const now = new Date('2026-05-01T12:00:00.000Z');
      const stale = new Date('2026-04-23T12:00:00.000Z');
      const leanMock = jest.fn().mockResolvedValue([{ organization: orgId, lastResetAt: stale }]);
      mockModel.find.mockReturnValue({ lean: leanMock });

      const result = await BillingSubscriptionRepository.findAllDueForResetByLastReset(now);

      expect(result).toEqual([{ organization: orgId, lastResetAt: stale }]);
    });

    test('excludes subscriptions reset within the last 7 days', async () => {
      const now = new Date('2026-05-01T12:00:00.000Z');
      mockModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });

      const result = await BillingSubscriptionRepository.findAllDueForResetByLastReset(now);

      expect(result).toEqual([]);
      const query = mockModel.find.mock.calls[0][0];
      expect(query.$or[1].lastResetAt.$lt).toEqual(new Date('2026-04-24T12:00:00.000Z'));
    });
  });

  describe('updateLastResetAt', () => {
    test('updates the subscription reset timestamp by organization', async () => {
      const date = new Date('2026-05-01T12:00:00.000Z');
      const exec = jest.fn().mockResolvedValue({ organization: orgId, lastResetAt: date });
      mockModel.findOneAndUpdate.mockReturnValue({ exec });

      const result = await BillingSubscriptionRepository.updateLastResetAt(orgId, date);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { organization: orgId },
        { $set: { lastResetAt: date } },
        { returnDocument: 'after', runValidators: true },
      );
      expect(result).toEqual({ organization: orgId, lastResetAt: date });
    });
  });

  // ── adminUpdatePlanOnly ────────────────────────────────────────────────────

  describe('adminUpdatePlanOnly', () => {
    const adminId = '707f1f77bcf86cd799439044';

    test('updates plan + adminUpdatedAt + adminUpdatedBy when ids are valid', async () => {
      const updated = { _id: subId, plan: 'pro', adminUpdatedBy: adminId };
      const execMock = jest.fn().mockResolvedValue(updated);
      const populateMock = jest.fn().mockReturnValue({ exec: execMock });
      mockModel.findByIdAndUpdate.mockReturnValue({ populate: populateMock });

      const result = await BillingSubscriptionRepository.adminUpdatePlanOnly(subId, 'pro', adminId);

      expect(mockModel.findByIdAndUpdate).toHaveBeenCalledWith(
        subId,
        expect.objectContaining({
          $set: expect.objectContaining({
            plan: 'pro',
            adminUpdatedBy: adminId,
          }),
        }),
        { returnDocument: 'after', runValidators: true },
      );
      expect(result).toEqual(updated);
    });

    test('returns null without querying when subscription id is invalid', async () => {
      const result = await BillingSubscriptionRepository.adminUpdatePlanOnly('not-valid', 'pro', adminId);
      expect(result).toBeNull();
      expect(mockModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    test('returns null without querying when subscription id is falsy', async () => {
      const result = await BillingSubscriptionRepository.adminUpdatePlanOnly(null, 'pro', adminId);
      expect(result).toBeNull();
      expect(mockModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    test('sets adminUpdatedBy to null when adminUserId is an invalid ObjectId', async () => {
      const execMock = jest.fn().mockResolvedValue({ _id: subId, plan: 'pro', adminUpdatedBy: null });
      const populateMock = jest.fn().mockReturnValue({ exec: execMock });
      mockModel.findByIdAndUpdate.mockReturnValue({ populate: populateMock });

      await BillingSubscriptionRepository.adminUpdatePlanOnly(subId, 'pro', 'not-an-objectid');

      const callArgs = mockModel.findByIdAndUpdate.mock.calls[0];
      expect(callArgs[1].$set.adminUpdatedBy).toBeNull();
    });

    test('sets adminUpdatedBy to null when adminUserId is an empty string', async () => {
      const execMock = jest.fn().mockResolvedValue({ _id: subId, plan: 'pro', adminUpdatedBy: null });
      const populateMock = jest.fn().mockReturnValue({ exec: execMock });
      mockModel.findByIdAndUpdate.mockReturnValue({ populate: populateMock });

      await BillingSubscriptionRepository.adminUpdatePlanOnly(subId, 'pro', '');

      const callArgs = mockModel.findByIdAndUpdate.mock.calls[0];
      expect(callArgs[1].$set.adminUpdatedBy).toBeNull();
    });

    test('sets adminUpdatedAt to a Date', async () => {
      const execMock = jest.fn().mockResolvedValue({ _id: subId, plan: 'pro' });
      const populateMock = jest.fn().mockReturnValue({ exec: execMock });
      mockModel.findByIdAndUpdate.mockReturnValue({ populate: populateMock });

      await BillingSubscriptionRepository.adminUpdatePlanOnly(subId, 'pro', adminId);

      const callArgs = mockModel.findByIdAndUpdate.mock.calls[0];
      expect(callArgs[1].$set.adminUpdatedAt).toBeInstanceOf(Date);
    });

    // V8 audit C3 — event-ordering markers must be bumped so a stale Stripe redelivery
    // cannot overwrite the admin plan bump via updateIfEventNewer.
    test('V8-C3: bumps lastSubscriptionEventCreatedAt + lastSubscriptionEventId so stale webhook is rejected', async () => {
      const execMock = jest.fn().mockResolvedValue({ _id: subId, plan: 'pro' });
      const populateMock = jest.fn().mockReturnValue({ exec: execMock });
      mockModel.findByIdAndUpdate.mockReturnValue({ populate: populateMock });

      const before = Math.floor(Date.now() / 1000);
      await BillingSubscriptionRepository.adminUpdatePlanOnly(subId, 'pro', adminId);
      const after = Math.floor(Date.now() / 1000);

      const callArgs = mockModel.findByIdAndUpdate.mock.calls[0];
      const { lastSubscriptionEventCreatedAt, lastSubscriptionEventId } = callArgs[1].$set;

      expect(lastSubscriptionEventCreatedAt).toBeGreaterThanOrEqual(before);
      expect(lastSubscriptionEventCreatedAt).toBeLessThanOrEqual(after);
      expect(lastSubscriptionEventId).toMatch(/^admin-bump-\d+$/);
    });
  });

  // ── markUnpaid — V8 audit C3 marker bump ─────────────────────────────────

  describe('markUnpaid — V8-C3 event-ordering markers', () => {
    const threshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    // V8 audit C3 — markUnpaid must bump markers so a stale customer.subscription.updated
    // redelivery cannot restore 'past_due' after the dunning sweep set 'unpaid'.
    test('V8-C3: bumps lastSubscriptionEventCreatedAt + lastSubscriptionEventId so stale webhook is rejected', async () => {
      const updated = { _id: subId, status: 'unpaid', plan: 'free' };
      mockModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) });

      const before = Math.floor(Date.now() / 1000);
      await BillingSubscriptionRepository.markUnpaid(subId, threshold);
      const after = Math.floor(Date.now() / 1000);

      const callArgs = mockModel.findOneAndUpdate.mock.calls[0];
      const { lastSubscriptionEventCreatedAt, lastSubscriptionEventId } = callArgs[1].$set;

      expect(lastSubscriptionEventCreatedAt).toBeGreaterThanOrEqual(before);
      expect(lastSubscriptionEventCreatedAt).toBeLessThanOrEqual(after);
      expect(lastSubscriptionEventId).toMatch(/^dunning-\d+$/);
    });
  });
});
