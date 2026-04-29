/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.extra.service.js
 */
describe('BillingExtraService unit tests:', () => {
  let BillingExtraService;
  let mockRepository;
  let mockConfig;

  const orgId = '507f1f77bcf86cd799439011';

  const makeDoc = (overrides = {}) => ({
    _id: '507f1f77bcf86cd799439099',
    organization: orgId,
    ledger: [],
    cachedBalance: 0,
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: true,
        plans: ['pro'],
        packs: [
          { packId: 'pack_500k', meterUnits: 500000, priceUsd: 49, stripePriceId: 'price_abc' },
          { packId: 'pack_2m', meterUnits: 2000000, priceUsd: 149, stripePriceId: 'price_def', expiryDays: 365 },
        ],
      },
    };

    mockRepository = {
      creditPack: jest.fn(),
      debit: jest.fn(),
      addExpirationEntries: jest.fn(),
      getOrCreate: jest.fn(),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
      default: mockRepository,
    }));

    const mod = await import('../services/billing.extra.service.js');
    BillingExtraService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('creditPack', () => {
    test('should delegate to repository with correct amount', async () => {
      const doc = makeDoc({ cachedBalance: 500000 });
      mockRepository.creditPack.mockResolvedValue({ doc, applied: true });

      const result = await BillingExtraService.creditPack(orgId, 'pack_500k', 'cs_abc');

      expect(mockRepository.creditPack).toHaveBeenCalledWith(orgId, 500000, 'cs_abc', null);
      expect(result.applied).toBe(true);
    });

    test('should compute expiresAt when pack has expiryDays', async () => {
      const doc = makeDoc({ cachedBalance: 2000000 });
      mockRepository.creditPack.mockResolvedValue({ doc, applied: true });

      const before = Date.now();
      await BillingExtraService.creditPack(orgId, 'pack_2m', 'cs_def');
      const after = Date.now();

      const [, , , expiresAt] = mockRepository.creditPack.mock.calls[0];
      expect(expiresAt).toBeInstanceOf(Date);
      const ms = expiresAt.getTime();
      expect(ms).toBeGreaterThanOrEqual(before + 365 * 24 * 60 * 60 * 1000 - 100);
      expect(ms).toBeLessThanOrEqual(after + 365 * 24 * 60 * 60 * 1000 + 100);
    });

    test('should return applied=false on idempotent re-call (same stripeSessionId)', async () => {
      const doc = makeDoc({ cachedBalance: 500000 });
      mockRepository.creditPack.mockResolvedValue({ doc, applied: false });

      const result = await BillingExtraService.creditPack(orgId, 'pack_500k', 'cs_abc_duplicate');
      expect(result.applied).toBe(false);
    });

    test('should throw when packId is unknown', async () => {
      await expect(BillingExtraService.creditPack(orgId, 'pack_unknown', 'cs_abc')).rejects.toThrow('Pack not found');
    });
  });

  describe('debit', () => {
    test('should delegate to repository', async () => {
      const doc = makeDoc({ cachedBalance: 400000 });
      mockRepository.debit.mockResolvedValue({ doc, applied: true });

      const result = await BillingExtraService.debit(orgId, 100000, 'ref_hist_123');

      expect(mockRepository.debit).toHaveBeenCalledWith(orgId, 100000, 'ref_hist_123');
      expect(result.applied).toBe(true);
    });

    test('should return applied=false when balance is insufficient', async () => {
      mockRepository.debit.mockResolvedValue({ doc: null, applied: false });

      const result = await BillingExtraService.debit(orgId, 999999999, 'ref_overflow');
      expect(result.applied).toBe(false);
    });

    test('debit same refId twice → second is no-op', async () => {
      const doc = makeDoc({ cachedBalance: 400000 });
      mockRepository.debit
        .mockResolvedValueOnce({ doc, applied: true })
        .mockResolvedValueOnce({ doc: null, applied: false });

      const r1 = await BillingExtraService.debit(orgId, 100, 'ref_same');
      const r2 = await BillingExtraService.debit(orgId, 100, 'ref_same');

      expect(r1.applied).toBe(true);
      expect(r2.applied).toBe(false);
    });
  });

  describe('expireOldEntries', () => {
    test('should delegate to repository with current date', async () => {
      mockRepository.addExpirationEntries.mockResolvedValue(2);

      const result = await BillingExtraService.expireOldEntries(orgId);

      expect(mockRepository.addExpirationEntries).toHaveBeenCalledWith(orgId, expect.any(Date));
      expect(result).toBe(2);
    });

    test('should return 0 when nothing expired', async () => {
      mockRepository.addExpirationEntries.mockResolvedValue(0);

      const result = await BillingExtraService.expireOldEntries(orgId);
      expect(result).toBe(0);
    });

    test('expireOldEntries is idempotent — re-run returns 0 the second time', async () => {
      mockRepository.addExpirationEntries
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      const r1 = await BillingExtraService.expireOldEntries(orgId);
      const r2 = await BillingExtraService.expireOldEntries(orgId);

      expect(r1).toBe(1);
      expect(r2).toBe(0); // idempotent
    });
  });

  describe('listLedger', () => {
    test('should return paginated ledger entries in reverse chronological order', async () => {
      const t1 = new Date('2026-05-01T10:00:00Z');
      const t2 = new Date('2026-05-02T10:00:00Z');
      const doc = makeDoc({
        cachedBalance: 900000,
        ledger: [
          { kind: 'topup', amount: 500000, at: t1 },
          { kind: 'topup', amount: 500000, at: t2 },
          { kind: 'debit', amount: -100000, at: new Date('2026-05-03T10:00:00Z') },
        ],
      });
      mockRepository.getOrCreate.mockResolvedValue(doc);

      const result = await BillingExtraService.listLedger(orgId, { page: 1, limit: 2 });

      expect(result.total).toBe(3);
      expect(result.balance).toBe(900000);
      expect(result.entries).toHaveLength(2);
      // Newest first
      expect(result.entries[0].kind).toBe('debit');
    });

    test('should return second page correctly', async () => {
      const doc = makeDoc({
        cachedBalance: 0,
        ledger: [
          { kind: 'topup', amount: 100, at: new Date('2026-01-01') },
          { kind: 'topup', amount: 100, at: new Date('2026-02-01') },
          { kind: 'topup', amount: 100, at: new Date('2026-03-01') },
        ],
      });
      mockRepository.getOrCreate.mockResolvedValue(doc);

      const result = await BillingExtraService.listLedger(orgId, { page: 2, limit: 2 });

      expect(result.entries).toHaveLength(1);
    });
  });

  describe('refundPartial', () => {
    test('should return applied=false when no matching topup entry found', async () => {
      const doc = makeDoc({ ledger: [] });
      mockRepository.getOrCreate.mockResolvedValue(doc);

      const result = await BillingExtraService.refundPartial(orgId, 'cs_notfound', 4900);
      expect(result.applied).toBe(false);
      expect(result.refundUnits).toBe(0);
    });

    test('should compute proportional refund units when pack is found', async () => {
      // pack_500k: 500000 units, $49 price — full refund of $49 = 500000 units back
      const topupEntry = {
        _id: '507f1f77bcf86cd799439aaa',
        kind: 'topup',
        amount: 500000,
        stripeSessionId: 'cs_refund_test',
      };
      const doc = makeDoc({ ledger: [topupEntry], cachedBalance: 500000 });
      mockRepository.getOrCreate.mockResolvedValue(doc);

      // Mock mongoose model for the findOneAndUpdate in refundPartial
      const mockMongoose = {
        model: jest.fn().mockReturnValue({
          findOneAndUpdate: jest.fn().mockResolvedValue(makeDoc({ cachedBalance: 0 })),
        }),
      };
      jest.unstable_mockModule('mongoose', () => ({ default: mockMongoose }));

      const result = await BillingExtraService.refundPartial(orgId, 'cs_refund_test', 4900);

      // $49 / $49 * 500000 = 500000 units
      expect(result.refundUnits).toBe(500000);
    });

    test('refundPartial with already-consumed balance still applies (economic reflection)', async () => {
      // The balance is 0 (units already consumed) but a refund should still be recorded
      const topupEntry = {
        _id: '507f1f77bcf86cd799439bbb',
        kind: 'topup',
        amount: 500000,
        stripeSessionId: 'cs_consumed',
      };
      const doc = makeDoc({ ledger: [topupEntry], cachedBalance: 0 });
      mockRepository.getOrCreate.mockResolvedValue(doc);

      const mockMongoose = {
        model: jest.fn().mockReturnValue({
          findOneAndUpdate: jest.fn().mockResolvedValue(makeDoc({ cachedBalance: -500000 })),
        }),
      };
      jest.unstable_mockModule('mongoose', () => ({ default: mockMongoose }));

      const result = await BillingExtraService.refundPartial(orgId, 'cs_consumed', 4900);
      // Applied (even with negative resulting balance — correct economic reflection)
      expect(result.applied).toBe(true);
    });
  });
});
